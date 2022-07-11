#!/usr/bin/env node
// @ts-check
'use strict';

const fs = require('node:fs/promises');
const orderBy = require('lodash/orderBy');
const {promisify} = require('node:util');
const {exec: originalExec} = require('node:child_process');
const exec = promisify(originalExec);
const getNextBranch = require('./get-forward-merge-branch');

function getBranches(/** @type string */ branch) {
  if (branch.startsWith('merge')) {
    // we're already merging, so extract branch information
    const matches = branch.match(/merge\/(.+)-into-(.+)/);
    if (matches) {
      return [matches[1], matches[2]];
    }
    console.error(`The branch name is not valid: ${branch}`);
    process.exit(1);
  }
  return [branch, getNextBranch(branch)];
}

async function main() {
  // get the current branch
  const {stdout: defaultBranch} = await exec(`git rev-parse --abbrev-ref HEAD`);
  const alreadyMerging = defaultBranch.startsWith('merge');

  let hasConflicts = false;
  const {GITHUB_REF: currentBranch = defaultBranch} = process.env;
  const [branch, nextBranch] = getBranches(currentBranch.replace('refs/heads/', ''));

  // create a merge branch
  if (!alreadyMerging) {
    console.log('Creating a merge branch');
    await exec(`git checkout -b merge/${branch}-into-${nextBranch}`);
  }

  try {
    const result = await exec(
      `git merge origin/${nextBranch} -m 'chore: Merge ${branch} into ${nextBranch} [skip release]'`
    );

    // The merge was successful with no merge conflicts
  } catch (result) {
    // The merge had conflicts

    /** @type {{stdout: string}} */
    const {stdout} = result;
    const lines = stdout.split('\n');

    // gather the merge conflicts
    const conflicts = lines
      .filter(line => line.startsWith('CONFLICT'))
      .map(line => {
        const match = line.match(/Merge conflict in (.+)/);
        return (match && match[1]) || '';
      });

    for (const conflict of conflicts) {
      console.log(`Attempting to resolve conflict in ${conflict}`);

      if (conflict === 'lerna.json' || conflict.includes('package.json')) {
        // resolve the conflicts by taking incoming file
        await exec(`git checkout --theirs -- "${conflict}"`);
        await exec(`git add ${conflict}`);

        console.log(`Resolved conflicts in ${conflict}`);
      } else if (conflict === 'CHANGELOG.md') {
        await updateChangelog();

        console.log(`Resolved conflicts in ${conflict}`);
      } else {
        console.log('Merge cannot be resolved automatically');
        hasConflicts = true;
        if (!alreadyMerging) {
          // If we're not already merging, we want to bail now - this is the default for CI
          // If we are already merging, we must be doing things manually
          process.exit(1);
        }
      }
    }

    await exec(`yarn install --production=false`);

    if (!hasConflicts) {
      // If we're here, we've fixed all merge conflicts. We need to commit
      await exec(`git add .`);
      await exec(`git commit --no-verify -m "chore: Merge ${branch} into ${nextBranch}"`);
    } else {
      // We have conflicts. Inform the user
      console.log(`Conflicts still need to be resolved manually.`);
      console.log(`Manually resolve the conflicts, then run the following command:`);
      console.log(
        `git add . && git commit --no-verify -m "chore: Merge ${branch} into ${nextBranch} [skip release]" && git push upstream merge/${branch}-into-${nextBranch}`
      );
    }
  }
}

main();

/**
 * @param line {string}
 */
function getHeadingMatch(line) {
  return line.match(/(#+) (.+)/);
}

async function updateChangelog() {
  let lines = (await fs.readFile('./CHANGELOG.md')).toString().split('\n');

  const header = lines.splice(0, 5);
  const releases = [];

  do {
    const [line, ...rest] = lines;
    lines = rest;
    const headingMatch = getHeadingMatch(line);
    if (headingMatch && headingMatch[1].length === 2) {
      const [rest, contents] = parseContents(lines);
      lines = rest;
      const dateMatch = headingMatch[0].match(/\([0-9]+-[0-9]+-[0-9]+\)/);
      const date = dateMatch && dateMatch[0];

      const release = {
        title: headingMatch[0],
        contents,
        date,
      };
      releases.push(release);
    }
  } while (lines.length);

  const sortedReleases = orderBy(releases, 'date', 'desc'); //?

  const contents = [
    ...header,
    ...sortedReleases.map(release => [release.title, ...release.contents]).flat(),
  ]
    // Remove the merge conflict markers - essentially "both" when resolving merge conflicts. We want both release notes if there's a conflict
    .filter(
      line => !line.startsWith('<<<<<<<') && !line.startsWith('>>>>>>>') && line !== '======='
    )
    .join('\n');

  await fs.writeFile('./CHANGELOG.md', contents);
}

/**
 *
 * @param lines {string[]}
 */
function parseContents(lines) {
  const contents = [];
  let remainingLines = lines;
  do {
    const [line, ...rest] = remainingLines;
    const headingMatch = getHeadingMatch(line);
    if (!headingMatch || headingMatch[1].length !== 2) {
      contents.push(line);
    } else {
      return [remainingLines, contents];
    }
    remainingLines = rest;
  } while (remainingLines.length);

  return [remainingLines, contents];
}

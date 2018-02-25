/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const db = require('../models/database').db;
const Migration = require('../models/Migration');
const { compare } = require('../util');

// file needed to run database transaction
const requiredFile = [];

/**
 * Create an array of unique versions;
 * @param migrationItems extracted from registerMigration.js
 * @returns {*[]} array of unique versions
 */
function getUniqueKeyOfMigrationList(migrationItems) {
	const vertex = [];

	for (const m of migrationItems) {
		// disallow down migration
		if (compare(m.fromVersion, m.toVersion) === 1) {
			throw new Error('Should not downgrade, please check registerMigration.js');
		} else {
			vertex.push(m.fromVersion);
			vertex.push(m.toVersion);
		}
	}

	return [...new Set(vertex)];
}

/**
 * create an adjacency list (OBJECT) of the migrations
 * @param migrationItems extracted from registerMigration.js
 * @returns {{}}
 */
function createMigrationList(migrationItems) {
	const migrationList = {};

	const uniqueKey = getUniqueKeyOfMigrationList(migrationItems);

	uniqueKey.forEach(key => {
		migrationList[key] = [];
	});

	for (const m of migrationItems) {
		migrationList[m.fromVersion].push(m);
	}

	return migrationList;
}

/**
 * If current version or version user wants to migrate is not in the migrationList, throw an Error
 * @param curr current version of the database
 * @param to version want to migrate to
 * @param adjListArray adjacency list of version graph
 */
function checkIfFromAndToExist(curr, to, adjListArray) {
	if (!(curr in adjListArray)) {
		throw new Error('Did not find version in migration list');
	}
	if (!(to in adjListArray)) {
		throw new Error('Did not find version in migration list');
	}
}

/**
 * Do a breath first search traversal to find the shortest path
 * from the current version to the version user want to migrate
 * It also works for down migration.
 * @param curr current version of the database
 * @param to version want to migrate to
 * @param adjListArray adjacency list of version graph
 * @returns {Array} return an array of indexes to the version that we want to migrate to
 */
function findPathToMigrate(curr, to, adjListArray) {
	const queue = [];
	const path = [];
	const visited = []; // When there is a cycle, make sure it is not infinite.

	checkIfFromAndToExist(curr, to, adjListArray);

	for (const vertex of Object.keys(adjListArray)) {
		visited[vertex] = false;
		path[vertex] = -1;
	}

	queue.push(curr);
	visited[curr] = true;

	while (queue.length > 0) {
		const currentVertexID = queue.shift();
		const currentVertex = adjListArray[currentVertexID];
		const edges = currentVertex.length;
		for (let i = 0; i < edges; i++) {
			const target = currentVertex[i];
			if (!visited[target.toVersion]) {
				visited[target.toVersion] = true;
				path[target.toVersion] = currentVertexID;
				queue.push(target.toVersion);
			}
		}
	}
	return path;
}

/**
 * Based on the path array, recursively find the correct file to the version wanted to update
 * and add it to the requiredFile array
 * @param curr current version of the database
 * @param to version want to migrate to
 * @param path array that store the indexes to the version that we want to migrate to
 */
function getRequiredFileToMigrate(curr, to, path) {
	if (curr === to) {
		requiredFile.push();
	} else if (path[to] === -1) {
		throw new Error('No path found');
	} else {
		getRequiredFileToMigrate(curr, path[to], path);
		requiredFile.push({
			fromVersion: path[to],
			toVersion: to
		});
	}
}

/**
 * Open a database transaction and migrate the database by calling up() method.
 * Insert row into migration folder
 * @param neededFile name of file needed to migrate
 * @param list is the migration list
 */
async function migrateDatabaseTransaction(neededFile, list) {
	await db.tx(async t => {
		neededFile.forEach(file => {
			for (const items of Object.keys(list)) {
				if (file.fromVersion === items) {
					list[items].forEach(async item => {
						if (item.toVersion === file.toVersion) {
							await item.up(t);
							const migration = new Migration(undefined, file.fromVersion, file.toVersion);
							try {
								await migration.insert(t);
							} catch (err) {

							}
						}
					});
				}
			}
		});
	}).then(data => {
		// success, COMMIT was executed
	}).catch(error => {
		// failure, ROLLBACK was executed
	});
}

/**
 * Migrate the database from current version to next version
 * @param toVersion is the version wanting to migrate to
 * @param migrationItems is the list of migration that users register
 */
async function migrateAll(toVersion, migrationItems) {
	const currentVersion = await Migration.getCurrentVersion();
	if (currentVersion === toVersion) {
		throw Error('You have the highest version');
	} else {
		const list = createMigrationList(migrationItems);
		const path = findPathToMigrate(currentVersion, toVersion, list);
		getRequiredFileToMigrate(currentVersion, toVersion, path);
		await migrateDatabaseTransaction(requiredFile, list);
	}
}

module.exports = {
	getUniqueKeyOfMigrationList,
	migrateAll
};

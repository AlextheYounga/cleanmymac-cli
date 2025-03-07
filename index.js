#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import bytes from 'bytes';

// Constants for file sizes
const GB = 1024 * 1024 * 1024;

// Main menu options
const SCAN_CACHE = 'Scan for cache files';
const SCAN_LARGE_FILES = 'Scan for large files (>1GB)';
const EXIT = 'Exit';

// macOS cache directories
const cacheDirs = [
	'~/Library/Caches',
	'~/Library/Logs',
	'~/Library/Application Support/*/Caches',
	'/Library/Caches'
];

// Function to recursively get file size
const getFileSizeRecursive = async (filePath) => {
	try {
		const stats = await fs.promises.stat(filePath);
		if (stats.isDirectory()) {
			const files = await fs.promises.readdir(filePath);
			const sizes = await Promise.all(
				files.map(async (file) => {
					try {
						return await getFileSizeRecursive(path.join(filePath, file));
					} catch (err) {
						return 0; // Skip files we can't access
					}
				})
			);
			return sizes.reduce((acc, size) => acc + size, 0);
		} else {
			return stats.size;
		}
	} catch (err) {
		return 0; // Return 0 for inaccessible files
	}
};

// Function to scan for large files and directories
const findLargeFiles = async (directory, listLimit = 1000, sizeThreshold = GB) => {
	const spinner = ora('Scanning for large files...').start();
	const results = [];

	const scanDir = async (dir) => {
		try {
			const files = await fs.promises.readdir(dir);

			for (const file of files) {
				try {
					const filePath = path.join(dir, file);
					const stats = await fs.promises.stat(filePath);

					if (stats.isDirectory()) {
						// Check if directory size exceeds threshold before adding
						const size = await getFileSizeRecursive(filePath);
						if (size >= sizeThreshold) {
							results.push({
								path: filePath,
								size: size,
								isDirectory: true
							});
							if (results.length >= listLimit) {
								spinner.succeed(`Found ${results.length} items larger than ${bytes(sizeThreshold)}`);
								return results;
							}
						} else {
							// Still scan subdirectories for large files
							await scanDir(filePath);
						}
					} else if (stats.size >= sizeThreshold) {
						results.push({
							path: filePath,
							size: stats.size,
							isDirectory: false
						});
						if (results.length >= listLimit) {
							spinner.succeed(`Found ${results.length} items larger than ${bytes(sizeThreshold)}`);
							return results;
						}
					}
				} catch (err) {
					// Skip files/directories we don't have access to
				}
			}
		} catch (err) {
			// Skip directories we can't read
		}
	};

	try {
		const expandedDir = directory.replace(/^~/, process.env.HOME);
		await scanDir(expandedDir);
		spinner.succeed(`Found ${results.length} items larger than 1GB`);
		return results;
	} catch (err) {
		spinner.fail(`Error scanning directory: ${err.message}`);
		return [];
	}
};

// Function to scan for cache files
const scanCacheFiles = async (sizeThreshold = (GB / 2)) => {
	const spinner = ora('Scanning for cache files...').start();
	const cacheFiles = [];

	try {
		for (const dir of cacheDirs) {
			try {
				const expandedDir = dir.replace(/^~/, process.env.HOME);

				// Handle glob patterns like */Caches
				if (expandedDir.includes('*')) {
					const baseDir = expandedDir.substring(0, expandedDir.indexOf('*'));
					const pattern = expandedDir.substring(expandedDir.indexOf('*') + 1);

					const baseDirExists = fs.existsSync(baseDir);
					if (!baseDirExists) continue;

					const items = await fs.promises.readdir(baseDir);
					for (const item of items) {
						const fullPath = path.join(baseDir, item, pattern);
						if (fs.existsSync(fullPath)) {
							const files = await fs.promises.readdir(fullPath);
							for (const file of files) {
								const filePath = path.join(fullPath, file);
								const stats = await fs.promises.stat(filePath);
								const size = stats.isDirectory() ? await getFileSizeRecursive(filePath) : stats.size;
								if (size >= sizeThreshold) {
									cacheFiles.push({
										path: filePath,
										size: size,
										isDirectory: stats.isDirectory()
									});
								}
							}
						}
					}
				} else {
					const dirExists = fs.existsSync(expandedDir);
					if (!dirExists) continue;

					const files = await fs.promises.readdir(expandedDir);
					for (const file of files) {
						const filePath = path.join(expandedDir, file);
						const stats = await fs.promises.stat(filePath);
						const size = stats.isDirectory() ? await getFileSizeRecursive(filePath) : stats.size;
						if (size >= sizeThreshold) {
							cacheFiles.push({
								path: filePath,
								size: size,
								isDirectory: stats.isDirectory()
							});
						}
					}
				}
			} catch (err) {
				// Skip directories we can't access
			}
		}

		spinner.succeed(`Found ${cacheFiles.length} cache items`);
		return cacheFiles;
	} catch (err) {
		spinner.fail(`Error scanning cache files: ${err.message}`);
		return [];
	}
};

// Display files and let user select which to delete
const selectFilesToDelete = async (files) => {
	// Sort files by size (largest first)
	files.sort((a, b) => b.size - a.size);

	const choices = files.map((file) => ({
		name: `${chalk.yellow(file.path)} ${chalk.green(bytes(file.size))} ${file.isDirectory ? chalk.blue('(Directory)') : ''}`,
		value: file.path,
		checked: false
	}));

	// Create a nice table to show top 5 largest files/folders
	const table = new Table({
		head: [chalk.cyan('Size'), chalk.cyan('Path'), chalk.cyan('Type')],
		colWidths: [15, 70, 12]
	});

	files.slice(0, 5).forEach(file => {
		table.push([
			bytes(file.size),
			file.path,
			file.isDirectory ? 'Directory' : 'File'
		]);
	});

	console.log(chalk.bold('\nTop 5 largest items:'));
	console.log(table.toString());
	console.log(chalk.bold(`\nTotal size: ${bytes(files.reduce((acc, file) => acc + file.size, 0))}`));

	const { selectedFiles } = await inquirer.prompt([
		{
			type: 'checkbox',
			name: 'selectedFiles',
			message: 'Select files/folders to delete:',
			choices,
			pageSize: 15
		}
	]);

	return selectedFiles;
};

// Delete selected files
const deleteFiles = async (files) => {
	if (files.length === 0) {
		console.log(chalk.yellow('No files selected for deletion.'));
		return;
	}

	const { confirm } = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'confirm',
			message: `Are you sure you want to delete ${files.length} selected items?`,
			default: false
		}
	]);

	if (!confirm) {
		console.log(chalk.yellow('Operation cancelled.'));
		return;
	}

	const spinner = ora('Deleting files...').start();
	let deletedCount = 0;
	let errorCount = 0;

	for (const file of files) {
		try {
			const stats = await fs.promises.stat(file);
			if (stats.isDirectory()) {
				await fs.promises.rm(file, { recursive: true, force: true });
			} else {
				await fs.promises.unlink(file);
			}
			deletedCount++;
		} catch (err) {
			errorCount++;
			console.error(chalk.red(`Error deleting ${file}: ${err.message}`));
		}
	}

	spinner.succeed(`Deleted ${deletedCount} items. Failed to delete ${errorCount} items.`);
};

// Main function
const main = async () => {
	console.log(chalk.bold.green('\n===== CleanMyMac CLI =====\n'));

	while (true) {
		const { action } = await inquirer.prompt([
			{
				type: 'list',
				name: 'action',
				message: 'What would you like to do?',
				choices: [SCAN_CACHE, SCAN_LARGE_FILES, EXIT]
			}
		]);

		if (action === EXIT) {
			console.log(chalk.green('Thank you for using CleanMyMac CLI!'));
			break;
		}

		let filesToChooseFrom = [];

		if (action === SCAN_CACHE) {
			filesToChooseFrom = await scanCacheFiles();
		} else if (action === SCAN_LARGE_FILES) {
			const { directory } = await inquirer.prompt([
				{
					type: 'input',
					name: 'directory',
					message: 'Enter directory to scan (default: ~/Documents):',
					default: '~/Documents'
				}
			]);

			filesToChooseFrom = await findLargeFiles(directory);
		}

		if (filesToChooseFrom.length === 0) {
			console.log(chalk.yellow('No files found matching the criteria.'));
			continue;
		}

		const selectedFiles = await selectFilesToDelete(filesToChooseFrom);
		await deleteFiles(selectedFiles);
	}
};

// Run the program
main().catch(err => {
	console.error(chalk.red(`Error: ${err.message}`));
	process.exit(1);
});

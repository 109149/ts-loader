var fs = require('fs-extra');
var path = require('path');
var execSync = require('child_process').execSync;

// Parse command line arguments
var saveOutputMode = process.argv.indexOf('--save-output') !== -1;
var indexOfSingleTest = process.argv.indexOf('--single-test');
var singleTestToRun = indexOfSingleTest !== -1 && process.argv[indexOfSingleTest + 1];

var passingTests = [];
var failingTests = [];

var start = new Date().getTime();
console.log('Starting to run test suites...\n');
var versionsHaveBeenReported = false;

if (singleTestToRun) {
    runTestAsChildProcess(singleTestToRun);
}
else {
    // loop through each test directory triggering a test run as child process
    fs.readdirSync(__dirname)
        .filter(function (testName) {
            var testPath = path.join(__dirname, testName);
            return fs.statSync(testPath).isDirectory();
        })
        .forEach(runTestAsChildProcess);
}

function runTestAsChildProcess(testName) {
    // console.log('Running ' + testName + ' as a child_process')
    try {
        // var testOutput = execSync('npm test -- --single-test ' + testName, { stdio: 'inherit' });
        var excludeVersions = versionsHaveBeenReported ? ' --exclude-versions' : '';
        var saveOutput = saveOutputMode ? ' --save-output' : '';
        versionsHaveBeenReported = true;
        var testOutput = execSync('mocha --reporter spec test/run.js --single-test ' + testName + excludeVersions, { stdio: 'inherit' });
        passingTests.push(testName);
    }
    catch (err) {
        failingTests.push(testName);
    }
}

var end = new Date().getTime();
console.log('\n-------------------------------------------------------------------------\n');
console.log((passingTests.length + failingTests.length) + ' test suites took ' + ((end - start) / 1000) + ' seconds to run.\n');
if (passingTests.length > 0) {
    console.log(passingTests.length + ' test suite(s) passed.\n\n - ' + passingTests.join('\n - ') + '\n');
}

if (failingTests.length > 0) {
    console.log(failingTests.length + ' test suite(s) failed.\n\n - ' + failingTests.join('\n - ') + '\n');
    process.exit(1);
}
else {
    console.log('No tests failed; congratulations!');
}

/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {EnvironmentClass} from 'types/Environment';
import type {GlobalConfig, Path, ProjectConfig} from 'types/Config';
import type {Resolver} from 'types/Resolve';
import type {TestFramework} from 'types/TestRunner';
import type {TestResult} from 'types/TestResult';
import type RuntimeClass from 'jest-runtime';

import fs from 'fs';
import {
  BufferedConsole,
  Console,
  NullConsole,
  getConsoleOutput,
  setGlobal,
} from 'jest-util';
import jasmine2 from 'jest-jasmine2';
import LeakDetector from 'jest-leak-detector';
import {getTestEnvironment} from 'jest-config';
import * as docblock from 'jest-docblock';

type RunTestInternalResult = {
  leakDetector: ?LeakDetector,
  result: TestResult,
};

// The default jest-runner is required because it is the default test runner
// and required implicitly through the `testRunner` ProjectConfig option.
jasmine2;

// Keeping the core of "runTest" as a separate function (as "runTestInternal")
// is key to be able to detect memory leaks. Since all variables are local to
// the function, when "runTestInternal" finishes its execution, they can all be
// freed, UNLESS something else is leaking them (and that's why we can detect
// the leak!).
//
// If we had all the code in a single function, we should manually nullify all
// references to verify if there is a leak, which is not maintainable and error
// prone. That's why "runTestInternal" CANNOT be inlined inside "runTest".
async function runTestInternal(
  path: Path,
  globalConfig: GlobalConfig,
  config: ProjectConfig,
  resolver: Resolver,
): Promise<RunTestInternalResult> {
  const testSource = fs.readFileSync(path, 'utf8');
  const parsedDocblock = docblock.parse(docblock.extract(testSource));
  const customEnvironment = parsedDocblock['jest-environment'];

  let testEnvironment = config.testEnvironment;

  if (customEnvironment) {
    testEnvironment = getTestEnvironment(
      Object.assign({}, config, {
        testEnvironment: customEnvironment,
      }),
    );
  }

  /* $FlowFixMe */
  const TestEnvironment = (require(testEnvironment): EnvironmentClass);
  /* $FlowFixMe */
  const testFramework = (require(config.testRunner): TestFramework);
  /* $FlowFixMe */
  const Runtime = (require(config.moduleLoader || 'jest-runtime'): Class<
    RuntimeClass,
  >);

  let environment = new TestEnvironment(config);

  const leakDetector = config.detectLeaks
    ? new LeakDetector(environment)
    : null;

  const consoleOut = globalConfig.useStderr ? process.stderr : process.stdout;
  const consoleFormatter = (type, message) =>
    getConsoleOutput(
      config.cwd,
      !!globalConfig.verbose,
      // 4 = the console call is buried 4 stack frames deep
      BufferedConsole.write([], type, message, 4),
    );

  let testConsole;

  if (globalConfig.silent) {
    testConsole = new NullConsole(consoleOut, process.stderr, consoleFormatter);
  } else if (globalConfig.verbose) {
    testConsole = new Console(consoleOut, process.stderr, consoleFormatter);
  } else {
    testConsole = new BufferedConsole();
  }

  let cacheFS = {[path]: testSource};
  setGlobal(environment.global, 'console', testConsole);

  const coverageOptions = {
    collectCoverage: globalConfig.collectCoverage,
    collectCoverageFrom: globalConfig.collectCoverageFrom,
    collectCoverageOnlyFrom: globalConfig.collectCoverageOnlyFrom,
    mapCoverage: globalConfig.mapCoverage,
  };

  let runtime = new Runtime(
    config,
    environment,
    resolver,
    cacheFS,
    coverageOptions,
    path,
  );

  const start = Date.now();
  await environment.setup();
  try {
    const result: TestResult = await testFramework(
      globalConfig,
      config,
      environment,
      runtime,
      path,
    );
    const testCount =
      result.numPassingTests + result.numFailingTests + result.numPendingTests;

    result.perfStats = {end: Date.now(), start};
    result.testFilePath = path;
    result.coverage = runtime.getAllCoverageInfo();
    result.sourceMaps = runtime.getSourceMapInfo();
    result.console = testConsole.getBuffer();
    result.skipped = testCount === result.numPendingTests;
    result.displayName = config.displayName;

    // Delay the resolution to allow log messages to be output.
    return new Promise(resolve => {
      setImmediate(() => resolve({leakDetector, result}));
    });
  } finally {
    if (environment.teardown) {
      await environment.teardown();
    }

    if (runtime.reset) {
      await runtime.reset();
    }

    // Free references to environment to avoid leaks.
    cacheFS = null;
    environment = null;
    runtime = null;
  }
}

export default async function runTest(
  path: Path,
  globalConfig: GlobalConfig,
  config: ProjectConfig,
  resolver: Resolver,
): Promise<TestResult> {
  const {leakDetector, result} = await runTestInternal(
    path,
    globalConfig,
    config,
    resolver,
  );

  if (globalConfig.logHeapUsage) {
    global.gc && global.gc();
    result.memoryUsage = process.memoryUsage().heapUsed;
  }

  // Resolve leak detector, outside the "runTestInternal" closure.
  result.leaks = leakDetector ? leakDetector.isLeaking() : false;

  return result;
}

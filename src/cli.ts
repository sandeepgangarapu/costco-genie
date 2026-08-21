#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDefaultCliActions, type CliActions } from './cli/actions.js';
import type { DoctorReport } from './cli/doctor.js';
import { AuthRequiredError } from './costco/errors.js';
import type { RunSummary } from './domain/types.js';
import { sanitizeDiagnosticText } from './lib/diagnostics.js';

export {
  createDefaultCliActions,
  type CliActions,
  type DefaultCliActionOptions,
  type DefaultCliDependencies,
} from './cli/actions.js';
export {
  diagnoseEnvironment,
  type DoctorCheck,
  type DoctorDependencies,
  type DoctorProbe,
  type DoctorReport,
} from './cli/doctor.js';

const HELP = `Usage: costco <command>

Commands:
  setup             Create local configuration and data storage
  login             Open the dedicated Chrome profile for manual Costco login
  run [--scheduled] Import receipts, check prices, and deliver new alerts
  status            Show data paths and the latest successful run
  install-agent     Install and load the daily macOS LaunchAgent
  uninstall-agent   Unload and remove the macOS LaunchAgent
  doctor            Check offline runtime, storage, Mail presence, and browser-profile readiness
  help               Show this help
`;

export interface CliIo {
  readonly error: (message: string) => void;
  readonly log: (message: string) => void;
}

export async function runCli(
  arguments_: readonly string[],
  actions: CliActions = createDefaultCliActions(),
  io: CliIo = console,
): Promise<number> {
  const [command, ...options] = arguments_;
  if (
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    io.log(HELP);
    return 0;
  }

  try {
    switch (command) {
      case 'setup':
        requireNoOptions(command, options);
        io.log(`Setup complete. Configuration: ${await actions.setup()}`);
        io.log('Next: run `costco login`.');
        return 0;
      case 'login':
        requireNoOptions(command, options);
        await actions.login();
        io.log(
          'Costco login window closed. Run `costco doctor` to check readiness.',
        );
        return 0;
      case 'run': {
        const scheduled = parseRunOptions(options);
        const summary = await actions.run({ scheduled });
        io.log(formatRunSummary(summary));
        const diagnostic = formatRunDiagnostic(summary);
        if (diagnostic !== null) io.error(diagnostic);
        if (summary.outcome === 'auth_required') {
          io.log('Recovery: run `costco login`, then run the check again.');
        }
        return runExitCode(summary.outcome);
      }
      case 'status':
        requireNoOptions(command, options);
        io.log(await actions.status());
        return 0;
      case 'install-agent':
        requireNoOptions(command, options);
        io.log(`LaunchAgent installed: ${await actions.installAgent()}`);
        return 0;
      case 'uninstall-agent':
        requireNoOptions(command, options);
        io.log(`LaunchAgent removed: ${await actions.uninstallAgent()}`);
        return 0;
      case 'doctor': {
        requireNoOptions(command, options);
        const report = await actions.doctor();
        io.log(formatDoctorReport(report));
        return report.ok ? 0 : 2;
      }
      default:
        io.error(`Unknown command: ${command}`);
        io.log(HELP);
        return 64;
    }
  } catch (error) {
    io.error(commandError(error));
    return error instanceof CliUsageError ? 64 : 1;
  }
}

function formatRunDiagnostic(summary: RunSummary): string | null {
  if (summary.diagnostic !== undefined) return summary.diagnostic;
  const channelErrors = [
    summary.notifications?.local.error,
    summary.notifications?.email.error,
  ].filter(
    (message): message is string => message !== null && message !== undefined,
  );
  if (channelErrors.length > 0) return channelErrors.join(' ');
  if (summary.outcome === 'failure') {
    return 'Run failed without additional diagnostic details.';
  }
  if (summary.outcome === 'partial_failure') {
    return 'Run completed with unresolved price or notification failures.';
  }
  return null;
}

function parseRunOptions(options: readonly string[]): boolean {
  if (options.length === 0) return false;
  if (options.length === 1 && options[0] === '--scheduled') return true;
  throw new CliUsageError(`Unknown run option: ${options.join(' ')}`);
}

function requireNoOptions(command: string, options: readonly string[]): void {
  if (options.length > 0) {
    throw new CliUsageError(`${command} does not accept options`);
  }
}

function formatRunSummary(summary: RunSummary): string {
  return [
    `Outcome: ${summary.outcome}`,
    `Purchases: ${String(summary.purchasesProcessed)}`,
    `Observations: ${String(summary.observationsRecorded)}`,
    `Unresolved: ${String(summary.unresolvedPrices)}`,
    `Potential adjustments: ${String(summary.candidatesFound)}`,
    `Alerts delivered: ${String(summary.alertsSent)}`,
    ...(summary.reportFiles === undefined
      ? []
      : [
          `HTML report: ${summary.reportFiles.htmlFile}`,
          `CSV report: ${summary.reportFiles.csvFile}`,
          `JSON report: ${summary.reportFiles.jsonFile}`,
        ]),
  ].join('\n');
}

function formatDoctorReport(report: DoctorReport): string {
  return report.checks
    .map(
      (check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`,
    )
    .join('\n');
}

function runExitCode(outcome: RunSummary['outcome']): number {
  switch (outcome) {
    case 'success':
    case 'skipped':
      return 0;
    case 'partial_failure':
      return 2;
    case 'auth_required':
      return 3;
    case 'failure':
      return 1;
  }
}

function commandError(error: unknown): string {
  const message = errorMessage(error);
  return error instanceof AuthRequiredError
    ? `${message}\nRecovery: run \`costco login\` and try again.`
    : message;
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return sanitizeDiagnosticText(value);
}

class CliUsageError extends Error {}

export function isDirectInvocation(
  executable: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  if (executable === undefined) return false;
  try {
    return realpathSync(executable) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(executable).href;
  }
}

if (isDirectInvocation(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}

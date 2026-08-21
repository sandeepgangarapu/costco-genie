const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 13;

export interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

export interface DoctorProbe {
  readonly detail: string;
  readonly ok: boolean;
}

export interface DoctorDependencies {
  readonly checkBrowserProfile: () => DoctorProbe;
  readonly checkDataDirectories: () => DoctorProbe;
  readonly checkDatabase: () => DoctorProbe;
  readonly checkLock: () => DoctorProbe;
  readonly checkMail: () => DoctorProbe;
  readonly nodeVersion: string;
  readonly platform: string;
}

export async function diagnoseEnvironment(
  dependencies: DoctorDependencies,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const platformOk = dependencies.platform === 'darwin';
  checks.push({
    detail: platformOk
      ? 'macOS detected'
      : `unsupported platform ${dependencies.platform}`,
    name: 'platform',
    ok: platformOk,
  });

  const runtimeOk = supportedNodeVersion(dependencies.nodeVersion);
  checks.push({
    detail: runtimeOk
      ? `Node ${dependencies.nodeVersion}`
      : `Node ${dependencies.nodeVersion}; require >=22.13.0`,
    name: 'runtime',
    ok: runtimeOk,
  });

  checks.push(
    probeCheck('data-directories', dependencies.checkDataDirectories),
  );
  checks.push(probeCheck('database', dependencies.checkDatabase));
  checks.push(probeCheck('lock', dependencies.checkLock));

  checks.push(probeCheck('mail', dependencies.checkMail));

  checks.push(probeCheck('browser-profile', dependencies.checkBrowserProfile));
  return { checks, ok: checks.every((check) => check.ok) };
}

function probeCheck(name: string, probe: () => DoctorProbe): DoctorCheck {
  try {
    return { ...probe(), name };
  } catch (error) {
    return { detail: errorMessage(error), name, ok: false };
  }
}

function supportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return (
    major > MINIMUM_NODE_MAJOR ||
    (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR)
  );
}

function errorMessage(error: unknown): string {
  return sanitizeDiagnosticText(
    error instanceof Error ? error.message : String(error),
  );
}
import { sanitizeDiagnosticText } from '../lib/diagnostics.js';

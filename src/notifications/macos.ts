import { execFile as defaultExecFile, type ExecFile } from '../lib/process.js';

const OSASCRIPT = '/usr/bin/osascript';
const NOTIFICATION_SCRIPT = `on run argv
  set notificationTitle to item 1 of argv
  set notificationBody to item 2 of argv
  display notification notificationBody with title notificationTitle
end run`;

export class MacOsNotificationError extends Error {
  constructor(options?: ErrorOptions) {
    super('Unable to send the macOS notification', options);
    this.name = 'MacOsNotificationError';
  }
}

export class MacOsNotifier {
  constructor(private readonly execFile: ExecFile = defaultExecFile) {}

  async send(title: string, body: string): Promise<void> {
    try {
      await this.execFile(OSASCRIPT, [
        '-e',
        NOTIFICATION_SCRIPT,
        '--',
        title,
        body,
      ]);
    } catch (error) {
      throw new MacOsNotificationError({ cause: error });
    }
  }
}

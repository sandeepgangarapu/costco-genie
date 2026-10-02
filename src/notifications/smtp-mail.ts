import nodemailer from 'nodemailer';
import { z } from 'zod';

import { readPrivateTextFile } from '../lib/filesystem.js';

const smtpSettingsSchema = z.object({
  smtp_host: z.string().trim().min(1),
  smtp_port: z.number().int().min(1).max(65535),
  smtp_user: z.string().trim().min(1),
  smtp_pass: z.string().min(1),
  email_from: z.string().email(),
  email_to: z.string().email(),
});

type SmtpSettings = z.infer<typeof smtpSettingsSchema>;

export class SmtpMailError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SmtpMailError';
  }
}

export class SmtpMailNotifier {
  constructor(private readonly configPath: string) {}

  async resolveSelfRecipient(): Promise<string> {
    return this.settings().email_to;
  }

  async send(
    recipient: string,
    subject: string,
    text: string,
    html?: string,
  ): Promise<void> {
    const settings = this.settings();
    const transport = nodemailer.createTransport({
      host: settings.smtp_host,
      port: settings.smtp_port,
      secure: settings.smtp_port === 465,
      requireTLS: settings.smtp_port !== 465,
      auth: {
        user: settings.smtp_user,
        pass: settings.smtp_pass,
      },
      connectionTimeout: 30_000,
      socketTimeout: 30_000,
      tls: { minVersion: 'TLSv1.2' },
    });
    try {
      await transport.sendMail({
        from: settings.email_from,
        to: recipient,
        subject,
        text,
        html,
      });
    } catch (error) {
      throw new SmtpMailError('Unable to send the SMTP message', {
        cause: error,
      });
    } finally {
      transport.close();
    }
  }

  private settings(): SmtpSettings {
    try {
      return smtpSettingsSchema.parse(
        JSON.parse(readPrivateTextFile(this.configPath)),
      );
    } catch (error) {
      throw new SmtpMailError(
        `Unable to read valid SMTP settings from ${this.configPath}`,
        { cause: error },
      );
    }
  }
}

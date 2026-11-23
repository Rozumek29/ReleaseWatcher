import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import {
  AppSettings,
  ChannelName,
  ChannelSettingKey,
  ChannelSettings,
  SettingSource,
  SettingsPatch,
} from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Icon, IconName } from '../../shared/icon';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';

export interface ChannelField {
  key: ChannelSettingKey;
  label: string;
  placeholder: string;
  /** Where to get the value. */
  hint: string;
  secret?: boolean;
  /** Optional fields are labelled as such. */
  optional?: boolean;
  /** Shown as a select with these values (the first is the default). */
  options?: readonly string[];
}

export interface ChannelDef {
  name: ChannelName;
  title: string;
  description: string;
  icon: IconName;
  fields: ChannelField[];
  /** Has an editor of extra request headers (webhook). */
  headers?: boolean;
}

/** Editable header row. `saved` = a value exists on the server; an empty value field keeps it. */
interface HeaderRow {
  id: number;
  name: string;
  value: string;
  saved: boolean;
}

const MAX_HEADERS = 10;

/** The push channels shown below Discord and e-mail (Settings → Notifications). */
export const CHANNELS: readonly ChannelDef[] = [
  {
    name: 'ntfy',
    title: 'ntfy',
    description: 'Push notifications through ntfy.sh or your own ntfy server.',
    icon: 'bellRing',
    fields: [
      {
        key: 'ntfyUrl',
        label: 'Server',
        placeholder: 'https://ntfy.sh',
        hint: 'Leave empty for the public server ntfy.sh.',
        optional: true,
      },
      {
        key: 'ntfyTopic',
        label: 'Topic',
        placeholder: 'releasewatcher-k3x9q',
        hint: 'Subscribe to it in the ntfy app. On ntfy.sh anyone who knows a topic can read it – pick a hard-to-guess name.',
      },
      {
        key: 'ntfyToken',
        label: 'Access token',
        placeholder: 'tk_… or user:password',
        hint: 'Only for protected topics: ntfy web app → Account → Access tokens.',
        secret: true,
        optional: true,
      },
    ],
  },
  {
    name: 'gotify',
    title: 'Gotify',
    description: 'Messages to your self-hosted Gotify server.',
    icon: 'server',
    fields: [
      { key: 'gotifyUrl', label: 'Server URL', placeholder: 'https://gotify.example.com', hint: 'Address of your Gotify server.' },
      {
        key: 'gotifyToken',
        label: 'App token',
        placeholder: 'AbCdEf…',
        hint: 'Gotify → Apps → Create application → copy its token.',
        secret: true,
      },
    ],
  },
  {
    name: 'telegram',
    title: 'Telegram',
    description: 'Messages from your bot to a chat, group or channel.',
    icon: 'send',
    fields: [
      {
        key: 'telegramBotToken',
        label: 'Bot token',
        placeholder: '123456789:AAE…',
        hint: 'Message @BotFather → /newbot, then add the bot to your chat.',
        secret: true,
      },
      {
        key: 'telegramChatId',
        label: 'Chat ID',
        placeholder: '-1001234567890 or @channel',
        hint: 'Send the bot a message, open api.telegram.org/bot<token>/getUpdates and copy chat.id.',
      },
    ],
  },
  {
    name: 'slack',
    title: 'Slack',
    description: 'Messages to a Slack channel through an incoming webhook.',
    icon: 'hash',
    fields: [
      {
        key: 'slackWebhookUrl',
        label: 'Webhook URL',
        placeholder: 'https://hooks.slack.com/services/…',
        hint: 'Slack → Apps → Incoming WebHooks → Add to Slack → pick a channel → copy the Webhook URL.',
        secret: true,
      },
    ],
  },
  {
    name: 'pushover',
    title: 'Pushover',
    description: 'Push notifications to your devices through Pushover.',
    icon: 'smartphone',
    fields: [
      {
        key: 'pushoverUserKey',
        label: 'User key',
        placeholder: 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG',
        hint: 'Shown at the top of your Pushover dashboard (a group key works too).',
        secret: true,
      },
      {
        key: 'pushoverAppToken',
        label: 'API token',
        placeholder: 'azGDORePK8gMaC0QOYAMyEEuzJnyUi',
        hint: 'pushover.net → Create an Application/API Token.',
        secret: true,
      },
    ],
  },
  {
    name: 'webhook',
    title: 'Webhook',
    description: 'Every notification as JSON to a URL of your choice.',
    icon: 'webhook',
    fields: [
      {
        key: 'webhookUrl',
        label: 'URL',
        placeholder: 'https://n8n.example.com/webhook/…',
        hint: 'Receives JSON with title, message, url and the event data – for n8n, Node-RED, Home Assistant and the like.',
        secret: true,
      },
      {
        key: 'webhookMethod',
        label: 'Method',
        placeholder: 'POST',
        hint: 'HTTP method of the request.',
        options: ['POST', 'PUT', 'PATCH'],
      },
    ],
    headers: true,
  },
];

/** Settings card of one push channel: its fields, Save, Send test and Remove. */
@Component({
  selector: 'app-channel-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Icon, UnsavedChanges],
  host: {
    class: 'card section enter',
    role: 'region',
    '[style.--i]': 'index()',
    '[attr.aria-labelledby]': "channel().name + '-title'",
  },
  templateUrl: './channel-card.html',
  styleUrl: './channel-card.scss',
})
export class ChannelCard implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly channel = input.required<ChannelDef>();
  readonly state = input.required<ChannelSettings>();
  readonly index = input(0);
  /** The settings after a save (the page keeps them). */
  readonly saved = output<AppSettings>();

  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  /** Secret fields shown in plain text. */
  protected readonly shown = signal<ReadonlySet<ChannelSettingKey>>(new Set());

  /** Form values; secrets start empty (empty on save = keep the saved one). */
  protected values: Partial<Record<ChannelSettingKey, string>> = {};
  protected headers: HeaderRow[] = [];
  protected readonly showHeaderValues = signal(false);
  protected readonly maxHeaders = MAX_HEADERS;
  private nextHeaderId = 1;
  private savedValues: unknown = null;

  ngOnInit(): void {
    this.fill(this.state());
  }

  protected field(key: ChannelSettingKey) {
    return this.state().settings[key];
  }

  protected toggleShown(key: ChannelSettingKey): void {
    const next = new Set(this.shown());
    if (!next.delete(key)) {
      next.add(key);
    }
    this.shown.set(next);
  }

  protected addHeader(name = '', value = ''): void {
    this.headers = [...this.headers, { id: this.nextHeaderId++, name, value, saved: false }];
  }

  protected removeHeader(row: HeaderRow): void {
    this.headers = this.headers.filter((h) => h !== row);
  }

  protected hasAuthorization(): boolean {
    return this.headers.some((h) => h.name.trim().toLowerCase() === 'authorization');
  }

  /** Whether any value was saved here (then it can be removed). */
  protected savedHere(): boolean {
    return this.channel().fields.some((f) => this.field(f.key)?.source === 'ui') || (this.state().headers?.length ?? 0) > 0;
  }

  protected changed(): boolean {
    return !sameValues(this.formValues(), this.savedValues);
  }

  protected sourceLabel(source: SettingSource | undefined): string {
    return source === 'ui' ? 'Saved here' : source === 'env' ? 'From environment' : 'Not set';
  }

  protected async save(): Promise<void> {
    const patch: SettingsPatch = {};
    for (const f of this.channel().fields) {
      const value = (this.values[f.key] ?? '').trim();
      if (f.secret) {
        // The saved secret is never shown; an empty field keeps it.
        if (value) {
          patch[f.key] = value;
        }
      } else {
        // Empty values reset to the environment default.
        patch[f.key] = value || null;
      }
    }
    if (this.channel().headers) {
      // A saved header with an empty value field keeps its value.
      patch.webhookHeaders = this.headers
        .filter((h) => h.name.trim())
        .map((h) => ({ name: h.name.trim(), value: h.value || (h.saved ? null : '') }));
    }
    await this.update(patch, `${this.channel().title} settings saved.`);
  }

  /** Removes everything saved here for the channel (environment values apply again). */
  protected async remove(): Promise<void> {
    const patch: SettingsPatch = {};
    for (const f of this.channel().fields) {
      patch[f.key] = null;
    }
    if (this.channel().headers) {
      patch.webhookHeaders = null;
    }
    await this.update(patch, `${this.channel().title} settings removed.`);
  }

  protected async sendTest(): Promise<void> {
    const { name, title } = this.channel();
    this.testing.set(true);
    try {
      const result = await firstValueFrom(this.api.sendTestNotification(name));
      if (result.failed.length > 0) {
        this.toast.error(`Sending to ${title} failed. Check the settings – the server log has the details.`);
      } else if (result.sent.length === 0) {
        this.toast.error(`${title} is not configured.`);
      } else {
        this.toast.success(`Test notification sent to ${title}.`);
      }
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.testing.set(false);
    }
  }

  private async update(patch: SettingsPatch, successText: string): Promise<void> {
    this.saving.set(true);
    this.errors.set({});
    try {
      const settings = await firstValueFrom(this.api.updateSettings(patch));
      this.fill(settings.channels[this.channel().name]);
      this.saved.emit(settings);
      this.toast.success(successText);
    } catch (error) {
      const fieldErrors = (error as { error?: { errors?: Record<string, string[]> } })?.error?.errors;
      if (fieldErrors) {
        this.errors.set(Object.fromEntries(Object.entries(fieldErrors).map(([k, v]) => [k, v.join(' ')])));
      } else {
        this.toast.error(error);
      }
    } finally {
      this.saving.set(false);
    }
  }

  private fill(state: ChannelSettings): void {
    this.values = Object.fromEntries(
      this.channel().fields.map((f) => [f.key, f.secret ? '' : (state.settings[f.key]?.value ?? f.options?.[0] ?? '')]),
    );
    this.headers = (state.headers ?? []).map((h) => ({ id: this.nextHeaderId++, name: h.name, value: '', saved: h.hasValue }));
    this.savedValues = this.formValues();
  }

  private formValues(): unknown {
    return [
      this.channel().fields.map((f) => (this.values[f.key] ?? '').trim()),
      this.headers.map((h) => [h.name.trim(), h.value]),
    ];
  }
}

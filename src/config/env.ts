import { createHash } from 'node:crypto';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Coage strings vazias para `undefined` para que os defaults do zod entrem em
 * acao. Sem isso, uma variavel presente mas vazia no `.env` derrubaria o boot.
 */
const optionalString = z
  .string()
  .transform((value) => (value.trim() === '' ? undefined : value.trim()))
  .optional();

const requiredString = (field: string) =>
  z
    .string({ required_error: `${field} e obrigatorio` })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, `${field} nao pode ser vazio`);

const intFromString = (fallback: number, min: number, max: number) =>
  optionalString
    .transform((value) => (value === undefined ? fallback : Number(value)))
    .refine(
      (value) => Number.isInteger(value) && value >= min && value <= max,
      `deve ser um inteiro entre ${min} e ${max}`,
    );

const csvNumbers = optionalString.transform((value) =>
  value === undefined
    ? []
    : value
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((part) => Number.isFinite(part)),
);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PORT: intFromString(3000, 1, 65535),

    TELEGRAM_BOT_TOKEN: requiredString('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).optional(),
    TELEGRAM_WEBHOOK_URL: optionalString,
    TELEGRAM_WEBHOOK_SECRET: optionalString,
    // O Render injeta a URL publica do servico automaticamente. Serve de
    // fallback para quem esquece de configurar TELEGRAM_WEBHOOK_URL.
    RENDER_EXTERNAL_URL: optionalString,

    GEMINI_API_KEY: requiredString('GEMINI_API_KEY'),
    GEMINI_MODEL: optionalString.transform((value) => value ?? 'gemini-3.6-flash'),

    ANTHROPIC_API_KEY: requiredString('ANTHROPIC_API_KEY'),
    ANTHROPIC_MODEL: optionalString.transform((value) => value ?? 'claude-opus-5'),
    ANTHROPIC_MAX_TOKENS: intFromString(700, 128, 8192),

    DATABASE_PATH: optionalString.transform((value) => value ?? './data/funnel.sqlite'),
    HISTORY_WINDOW: intFromString(20, 2, 100),

    AGENT_NAME: optionalString.transform((value) => value ?? 'Pedrito'),
    PLATFORM_NAME: optionalString.transform((value) => value ?? 'a plataforma'),
    AFFILIATE_LINK: optionalString.transform((value) => value ?? ''),
    CURRENT_OFFER: optionalString.transform((value) => value ?? 'bonus de boas-vindas'),
    MIN_DEPOSIT: optionalString.transform((value) => value ?? 'R$ 20'),
    MIN_AGE: intFromString(18, 0, 99),
    COMPLIANCE_NOTE: optionalString.transform(
      (value) =>
        value ??
        'Conteudo para maiores de 18 anos. Invista/aposte apenas o que puder perder.',
    ),

    RATE_LIMIT_MAX: intFromString(12, 1, 1000),
    RATE_LIMIT_WINDOW_SECONDS: intFromString(60, 1, 3600),

    ADMIN_CHAT_IDS: csvNumbers,
  });

export type Env = Omit<
  z.infer<typeof schema>,
  'TELEGRAM_MODE' | 'TELEGRAM_WEBHOOK_URL' | 'TELEGRAM_WEBHOOK_SECRET'
> & {
  /** Modo resolvido: webhook sempre que existir uma URL publica. */
  TELEGRAM_MODE: 'polling' | 'webhook';
  /** URL publica ja normalizada (sem barra final), ou null se nao houver. */
  TELEGRAM_WEBHOOK_URL: string | null;
  /** Segredo do header do Telegram; derivado do token quando nao configurado. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Token do GET /stats: so existe se o segredo foi configurado a mao. */
  adminToken: string | null;
  /** Caminho absoluto do SQLite (ou ":memory:"). */
  databaseFile: string;
  /** Rota principal do webhook, derivada do token. */
  webhookPath: string;
  /** Alias fixo aceito junto da rota principal. */
  webhookAliasPath: string;
};

/**
 * O Telegram so autentica o webhook pelo header de segredo. Exigir a variavel
 * faria o boot falhar em quem so configurou a URL — e um deploy que nao sobe
 * ajuda menos que um segredo derivado. O hash do token e estavel entre
 * restarts e imprevisivel para quem nao tem o token.
 */
function deriveWebhookSecret(token: string): string {
  return createHash('sha256').update(`telegram-webhook:${token}`).digest('hex');
}

function normalizePublicUrl(value: string | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
    .join('\n');
}

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(
      `Variaveis de ambiente invalidas. Confira o .env.example:\n${formatIssues(parsed.error)}`,
    );
  }

  const value = parsed.data;

  const databaseFile =
    value.DATABASE_PATH === ':memory:'
      ? ':memory:'
      : path.resolve(process.cwd(), value.DATABASE_PATH);

  // Deriva um caminho nao adivinhavel a partir do token, como recomenda o
  // Telegram, em vez de expor um /webhook publico.
  const tokenTail = value.TELEGRAM_BOT_TOKEN.split(':').pop() ?? value.TELEGRAM_BOT_TOKEN;

  // A URL publica vem da configuracao explicita ou, no Render, do proprio
  // ambiente. Ter uma URL e o que decide o modo: um servico web alcancavel
  // pela internet deve receber webhook, nao ficar fazendo long polling —
  // em plataformas que hibernam por inatividade o polling morre no primeiro
  // spin-down e nunca mais acorda, porque nada volta a bater na porta.
  const publicUrl =
    normalizePublicUrl(value.TELEGRAM_WEBHOOK_URL) ??
    normalizePublicUrl(value.RENDER_EXTERNAL_URL);

  const mode = value.TELEGRAM_MODE ?? (publicUrl ? 'webhook' : 'polling');

  if (mode === 'webhook' && !publicUrl) {
    throw new Error(
      'TELEGRAM_MODE=webhook exige TELEGRAM_WEBHOOK_URL (a URL publica https:// do servico).',
    );
  }

  if (publicUrl && !/^https:\/\/.+/.test(publicUrl)) {
    throw new Error(
      `URL publica invalida: "${publicUrl}". O Telegram so aceita webhook em https://.`,
    );
  }

  const configuredSecret = value.TELEGRAM_WEBHOOK_SECRET;

  if (configuredSecret && configuredSecret.length < 16) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET precisa ter ao menos 16 caracteres.');
  }

  return {
    ...value,
    TELEGRAM_MODE: mode,
    TELEGRAM_WEBHOOK_URL: publicUrl,
    TELEGRAM_WEBHOOK_SECRET:
      configuredSecret ?? deriveWebhookSecret(value.TELEGRAM_BOT_TOKEN),
    adminToken: configuredSecret ?? null,
    databaseFile,
    webhookPath: `/telegram/${tokenTail}`,
    webhookAliasPath: '/webhook',
  };
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';

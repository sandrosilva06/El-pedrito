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
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_WEBHOOK_URL: optionalString,
    TELEGRAM_WEBHOOK_SECRET: optionalString,

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
  })
  .superRefine((value, ctx) => {
    if (value.TELEGRAM_MODE !== 'webhook') return;

    if (!value.TELEGRAM_WEBHOOK_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_WEBHOOK_URL'],
        message: 'e obrigatorio quando TELEGRAM_MODE=webhook',
      });
    } else if (!/^https:\/\/.+/.test(value.TELEGRAM_WEBHOOK_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_WEBHOOK_URL'],
        message: 'deve ser uma URL https:// publica',
      });
    }

    // O Telegram so aceita o header de segredo; sem ele qualquer um que
    // descubra a URL consegue injetar updates falsos no funil.
    if (!value.TELEGRAM_WEBHOOK_SECRET || value.TELEGRAM_WEBHOOK_SECRET.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message: 'e obrigatorio em modo webhook e precisa ter ao menos 16 caracteres',
      });
    }
  });

export type Env = z.infer<typeof schema> & {
  /** Caminho absoluto do SQLite (ou ":memory:"). */
  databaseFile: string;
  /** Rota registrada no Express e no Telegram, derivada do token. */
  webhookPath: string;
};

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

  return {
    ...value,
    databaseFile,
    webhookPath: `/telegram/${tokenTail}`,
  };
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';

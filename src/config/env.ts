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
    // Caminho registrado no Telegram. O default e /webhook por ser o que se
    // consegue verificar a olho — o segredo no header e que autentica, nao a
    // obscuridade do caminho.
    TELEGRAM_WEBHOOK_PATH: optionalString,
    // O Render injeta a URL publica do servico automaticamente. Servem de
    // fallback para quem esquece de configurar TELEGRAM_WEBHOOK_URL.
    RENDER_EXTERNAL_URL: optionalString,
    RENDER_EXTERNAL_HOSTNAME: optionalString,

    GEMINI_API_KEY: requiredString('GEMINI_API_KEY'),
    // Modelo do estrategista. GEMINI_MODEL e o nome antigo, mantido para nao
    // quebrar deploys que ja o tenham configurado.
    GEMINI_MODEL: optionalString,
    GEMINI_STRATEGIST_MODEL: optionalString,
    // Modelo do redator. O default e DIFERENTE do estrategista de proposito:
    // a quota do plano gratuito e contada por modelo
    // (GenerateRequestsPerMinutePerProjectPerModel), e a cadeia gasta duas
    // chamadas por mensagem do lead. Com os dois papeis no mesmo modelo, o
    // teto efetivo cai pela metade.
    GEMINI_WRITER_MODEL: optionalString.transform((value) => value ?? 'gemini-3.5-flash'),
    GEMINI_WRITER_MAX_TOKENS: intFromString(700, 128, 8192),

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
  /** Modelo resolvido do estrategista. */
  GEMINI_MODEL: string;
  /** Alias fixo aceito junto da rota principal. */
  webhookAliasPath: string;
  /** De onde veio o modo: config explicita, deducao, ou imposicao de producao. */
  modeSource: 'explicito' | 'automatico' | 'forcado-em-producao';
  /** Producao sem URL publica: nao da para registrar webhook e o bot fica mudo. */
  missingPublicUrlInProduction: boolean;
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

function normalizeWebhookPath(value: string | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return null;

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
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
  const renderUrl =
    normalizePublicUrl(value.RENDER_EXTERNAL_URL) ??
    // Alguns servicos do Render expoem so o hostname, sem o esquema.
    (value.RENDER_EXTERNAL_HOSTNAME
      ? normalizePublicUrl(`https://${value.RENDER_EXTERNAL_HOSTNAME}`)
      : null);

  const publicUrl = normalizePublicUrl(value.TELEGRAM_WEBHOOK_URL) ?? renderUrl;

  const inProduction = value.NODE_ENV === 'production';

  // Em producao com URL publica o webhook e imposto, mesmo contra um
  // TELEGRAM_MODE=polling deixado para tras na plataforma: um servico que
  // hiberna por inatividade nunca volta a fazer polling depois do primeiro
  // spin-down, e o resultado e um bot silenciosamente morto. A imposicao
  // aparece no /health e nos logs — nao e silenciosa.
  const forcedByProduction = inProduction && Boolean(publicUrl) && value.TELEGRAM_MODE === 'polling';

  const mode =
    inProduction && publicUrl
      ? 'webhook'
      : (value.TELEGRAM_MODE ?? (publicUrl ? 'webhook' : 'polling'));

  // Producao sem URL publica nao tem como registrar webhook. Nao derruba o
  // boot: o processo sobe em polling para o /health poder explicar o motivo,
  // o que e mais util que um container reiniciando em loop.
  const missingPublicUrlInProduction = inProduction && !publicUrl;

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

  const webhookPath = normalizeWebhookPath(value.TELEGRAM_WEBHOOK_PATH) ?? '/webhook';

  return {
    ...value,
    TELEGRAM_MODE: mode,
    TELEGRAM_WEBHOOK_URL: publicUrl,
    TELEGRAM_WEBHOOK_SECRET:
      configuredSecret ?? deriveWebhookSecret(value.TELEGRAM_BOT_TOKEN),
    adminToken: configuredSecret ?? null,
    GEMINI_MODEL:
      value.GEMINI_STRATEGIST_MODEL ?? value.GEMINI_MODEL ?? 'gemini-3.6-flash',
    databaseFile,
    webhookPath,
    // O caminho derivado do token continua aceito, para nao quebrar um webhook
    // que ja tenha sido registrado nele.
    webhookAliasPath: `/telegram/${tokenTail}`,
    modeSource: forcedByProduction
      ? 'forcado-em-producao'
      : value.TELEGRAM_MODE
        ? 'explicito'
        : 'automatico',
    missingPublicUrlInProduction,
  };
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';

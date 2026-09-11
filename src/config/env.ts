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

/**
 * Canal de administracao para onde vao os comprovativos. Fica como default no
 * codigo para o reencaminhamento funcionar mesmo num deploy onde a variavel
 * nao foi configurada — sem destino, o print e guardado e ninguem e avisado.
 * A variavel de ambiente, quando existe, continua a ganhar.
 */
const DEFAULT_ADMIN_CHAT_IDS = [-1_004_453_145_425];

/**
 * Le uma lista de chat ids separados por virgula.
 *
 * Ids de grupo e canal sao negativos e grandes; acima de 2^53 o Number perde
 * precisao e a mensagem iria parar a um chat que nao existe, por isso os que
 * nao sobrevivem inteiros sao deitados fora aqui e nao mais a frente.
 */
function parseChatIds(value: string | undefined): number[] {
  if (value === undefined) return [];

  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isSafeInteger(part));
}

const csvNumbers = optionalString.transform((value) =>
  value === undefined ? DEFAULT_ADMIN_CHAT_IDS : parseChatIds(value),
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

    /** Influencer activo. Ver src/personas/. */
    BOT_PERSONA: optionalString.transform((value) => value ?? 'el_pedrito'),

    AGENT_NAME: optionalString.transform((value) => value ?? 'El Pedrito'),
    /** Grupo VIP que o funil promove — o produto desta fase. */
    GROUP_NAME: optionalString.transform((value) => value ?? 'El Pedrito Tips'),
    /** Publico a que o grupo se dirige, citado como posicionamento. */
    TARGET_AUDIENCE: optionalString.transform(
      (value) => value ?? 'portugueses emigrantes na Suica',
    ),
    /** Casa onde o lead faz registo e deposito para desbloquear o grupo. */
    PLATFORM_NAME: optionalString.transform((value) => value ?? 'GangstaSino'),
    AFFILIATE_LINK: optionalString.transform((value) => value ?? ''),
    MIN_DEPOSIT: optionalString.transform((value) => value ?? '20€'),
    /** Quantas entradas o grupo envia por dia. */
    TIPS_PER_DAY: intFromString(8, 1, 100),
    /**
     * Marco de assertividade citado como prova social. Fica em variavel, e nao
     * fixo no prompt, porque e uma afirmacao de facto sobre resultados: o
     * redator tem instrucao de nunca inventar numeros e so diz o que estiver
     * aqui. Vazio = fala de assertividade sem numeros.
     */
    HIT_RATE_CLAIM: optionalString.transform(
      (value) => value ?? 'no ultimo Mundial batemos 30 greens seguidos',
    ),
    /**
     * Volume levantado pela comunidade, citado como prova social. Mesma regra:
     * o bot so afirma o que estiver configurado aqui.
     */
    PAYOUT_CLAIM: optionalString.transform(
      (value) => value ?? 'a malta ja levantou mais de 300.000€ da plataforma',
    ),
    /**
     * Argumentos sobre a plataforma usados para tratar a objecao de confianca.
     * Ficam em variavel pela mesma razao dos numeros de resultados: sao
     * afirmacoes de facto repetidas ao lead antes de ele depositar.
     */
    PLATFORM_TRUST_CLAIM: optionalString.transform(
      (value) =>
        value ??
        'e das melhores a operar na Suica, com odds fortes e levantamentos rapidos',
    ),
    /** Valor sugerido como ideal para acompanhar as entradas do dia. */
    SUGGESTED_DEPOSIT: optionalString.transform((value) => value ?? '50€'),

    // --- Ivan Rodrigues ----------------------------------------------------
    IVAN_NAME: optionalString.transform((value) => value ?? 'Ivan Rodrigues'),
    IVAN_MIN_DEPOSIT: optionalString.transform((value) => value ?? '25€'),
    /**
     * Lifestyle que o Ivan pode referir, como prova de que o caminho existe.
     * Fica em variavel, e nao fixo no prompt, pela mesma razao dos numeros de
     * resultados: sao afirmacoes de facto sobre bens e ganhos, ditas ao lead
     * antes de ele depositar, e a responsabilidade por elas e de quem opera o
     * bot, nao do codigo. Pode ser reescrita no ambiente a qualquer momento.
     */
    IVAN_LIFESTYLE_CLAIM: optionalString.transform(
      (value) =>
        value ??
        'faturou mais de 3 milhoes de euros pela internet, vive entre Portugal e ' +
          'as casas que tem no Dubai, anda de Porsche Taycan e de Mercedes CLA 45 ' +
          'AMG, e o que mais o orgulha e dar a familia uma vida de conforto',
    ),
    /**
     * Historia de origem do Ivan. Mesma regra do lifestyle: e uma afirmacao
     * sobre a vida dele, contada ao lead para criar identificacao antes de o
     * fazer depositar. Vazia, ele nao conta historia nenhuma.
     */
    IVAN_STORY_CLAIM: optionalString.transform((value) => value ?? ''),
    /** Banca aconselhada (nao exigida) para aguentar o dia. */
    IVAN_SUGGESTED_DEPOSIT: optionalString.transform((value) => value ?? '50€'),
    /**
     * Como se comportam os levantamentos na casa. Mesma regra do HIT_RATE e do
     * PAYOUT do El Pedrito: e uma afirmacao sobre o servico de um terceiro,
     * dita ao lead para ele destravar o deposito, por isso fica no ambiente e
     * a autoria e de quem opera o bot. Vazia, o Ivan nao fala em prazos.
     */
    IVAN_WITHDRAWAL_CLAIM: optionalString.transform(
      (value) => value ?? 'os saques sao praticamente instantaneos',
    ),
    /** Casas do Ivan. A Plan Bet e a principal. */
    PLANBET_LINK: optionalString.transform((value) => value ?? ''),
    CASINO22_LINK: optionalString.transform((value) => value ?? ''),
    GINJA_LINK: optionalString.transform((value) => value ?? ''),

    MIN_AGE: intFromString(18, 0, 99),
    COMPLIANCE_NOTE: optionalString.transform(
      (value) =>
        value ??
        'Conteudo para maiores de 18 anos. Aposta apenas o que podes perder.',
    ),

    // --- Ritmo de chat ------------------------------------------------------
    /** Quantas mensagens curtas, no maximo, por resposta. */
    MAX_BUBBLES: intFromString(4, 1, 8),
    /** Duracao do "a escrever..." antes de cada mensagem, em ms. */
    TYPING_MS_MIN: intFromString(7000, 0, 60000),
    TYPING_MS_MAX: intFromString(8000, 0, 60000),
    /** Pausa depois de enviar, antes de comecar a escrever a seguinte. */
    BUBBLE_PAUSE_MS_MIN: intFromString(1000, 0, 30000),
    BUBBLE_PAUSE_MS_MAX: intFromString(2000, 0, 30000),

    // --- Remarketing -------------------------------------------------------
    /** Liga/desliga o envio automatico. */
    REMARKETING_ENABLED: optionalString.transform((value) => value !== 'false'),
    /** Horarios dos envios, hora local do fuso abaixo. */
    REMARKETING_SLOTS: optionalString.transform((value) => value ?? '09:30,14:30,20:30'),
    /** Fuso dos leads. A Suica, nao o servidor. */
    REMARKETING_TIMEZONE: optionalString.transform((value) => value ?? 'Europe/Zurich'),
    /**
     * Quantas mensagens de remarketing um lead que nao converteu recebe, no
     * total, antes de o bot se calar. Sem tecto, o lead que nao respondeu ao
     * decimo lembrete tambem nao responde ao centesimo — so bloqueia o bot, e
     * bloqueios em massa fazem o Telegram limitar a conta.
     */
    REMARKETING_MAX_TOUCHES: intFromString(9, 1, 1000),
    /** Horas minimas entre a ultima atividade do lead e um lembrete. */
    REMARKETING_QUIET_HOURS: intFromString(20, 1, 720),

    RATE_LIMIT_MAX: intFromString(12, 1, 1000),
    RATE_LIMIT_WINDOW_SECONDS: intFromString(60, 1, 3600),

    ADMIN_CHAT_IDS: csvNumbers,

    /**
     * Canal de controlo para onde vao as copias das imagens recebidas. Quando
     * definido, SUBSTITUI o ADMIN_CHAT_IDS como destino das midias: quem o
     * configura quer redirecionar, e uniao das duas listas entregaria a mesma
     * imagem duas vezes.
     *
     * TELEGRAM_ADMIN_CHAT_ID e aceite como nome alternativo do mesmo campo.
     * Ambos aceitam varios ids separados por virgula.
     */
    TELEGRAM_LOG_CHANNEL_ID: optionalString,
    TELEGRAM_ADMIN_CHAT_ID: optionalString,
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
  /** Destino das copias das midias recebidas, ja resolvido. */
  mediaLogChatIds: number[];
  /** De onde veio esse destino, para o log de arranque dizer o que esta ativo. */
  mediaLogSource: 'TELEGRAM_LOG_CHANNEL_ID' | 'TELEGRAM_ADMIN_CHAT_ID' | 'ADMIN_CHAT_IDS';
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
    ...resolveMediaLog(value.TELEGRAM_LOG_CHANNEL_ID, value.TELEGRAM_ADMIN_CHAT_ID, value.ADMIN_CHAT_IDS),
  };
}

/**
 * Escolhe para onde vao as copias das imagens.
 *
 * O canal dedicado ganha ao ADMIN_CHAT_IDS em vez de se somar a ele: quem
 * configura um canal de log quer redirecionar as midias, e somar as duas
 * listas entregaria a mesma imagem duas vezes a quem estivesse nas duas.
 *
 * Uma variavel presente mas sem nenhum id valido nao cai para tras em
 * silencio: e um id mal escrito, e mandar as imagens para o destino antigo
 * esconderia o erro de quem acabou de o configurar.
 */
function resolveMediaLog(
  logChannel: string | undefined,
  adminChat: string | undefined,
  fallback: number[],
): Pick<Env, 'mediaLogChatIds' | 'mediaLogSource'> {
  if (logChannel !== undefined) {
    return { mediaLogChatIds: parseChatIds(logChannel), mediaLogSource: 'TELEGRAM_LOG_CHANNEL_ID' };
  }

  if (adminChat !== undefined) {
    return { mediaLogChatIds: parseChatIds(adminChat), mediaLogSource: 'TELEGRAM_ADMIN_CHAT_ID' };
  }

  return { mediaLogChatIds: fallback, mediaLogSource: 'ADMIN_CHAT_IDS' };
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';

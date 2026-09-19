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

const csvNumbers = optionalString.transform((value) =>
  value === undefined
    ? DEFAULT_ADMIN_CHAT_IDS
    : value
        .split(',')
        .map((part) => Number(part.trim()))
        // Ids de grupo e canal sao negativos e grandes; acima de 2^53 o Number
        // perde precisao e a mensagem iria para um chat que nao existe.
        .filter((part) => Number.isSafeInteger(part)),
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
     * segundo lembrete tambem nao responde ao decimo — so bloqueia o bot, e
     * bloqueios em massa fazem o Telegram limitar a conta.
     *
     * O codigo trava isto em 2 de qualquer maneira (ver NAO_CONVERTIDO_TOUCHES
     * no servico): so ha guiao escrito para dois toques, e um terceiro sairia
     * sem texto proprio.
     */
    REMARKETING_MAX_TOUCHES: intFromString(2, 1, 1000),
    /** Horas minimas entre a ultima atividade do lead e um lembrete. */
    REMARKETING_QUIET_HOURS: intFromString(20, 1, 720),
    /**
     * Quanto tempo o lead tem de estar calado antes do PRIMEIRO toque. Conta
     * desde a ultima coisa que ele disse, nao desde que entrou.
     */
    REMARKETING_FIRST_TOUCH_HOURS: intFromString(24, 1, 720),
    /**
     * Intervalo entre o primeiro e o segundo toque. Com o valor por omissao o
     * segundo cai as 72h de silencio (24 + 48), que e o que se combinou.
     */
    REMARKETING_SECOND_TOUCH_HOURS: intFromString(48, 1, 720),
    /**
     * Silencio necessario para tocar em quem ja recebeu o link.
     *
     * Muito mais curto do que o toque normal de proposito: um lead que recebeu
     * o link ha duas horas e ficou calado nao mudou de ideias, travou em
     * alguma coisa. Esperar 24h e chegar tarde.
     */
    REMARKETING_LINK_STALLED_HOURS: intFromString(3, 1, 168),
    /**
     * Pausa entre envios dentro da mesma campanha. O Telegram limita a ~30
     * mensagens por segundo e responde a rajadas com 429; 120ms deixa margem
     * e continua a despachar uma lista grande em pouco tempo.
     */
    REMARKETING_SEND_INTERVAL_MS: intFromString(120, 0, 60_000),

    RATE_LIMIT_MAX: intFromString(12, 1, 1000),
    RATE_LIMIT_WINDOW_SECONDS: intFromString(60, 1, 3600),

    ADMIN_CHAT_IDS: csvNumbers,
    /**
     * Leads que voltam SEMPRE, aprovados e afixados, a cada arranque.
     *
     * Enquanto a base de dados viver dentro da pasta da aplicacao, um deploy
     * apaga-a: os leads, o historico e o estado do remarketing desaparecem. Um
     * lead que ja depositou e ja esta no grupo nao pode depender disso — a
     * seguir ao deploy o bot trata-o como um desconhecido e recomeca o funil
     * com quem ja pagou.
     *
     * Aqui ficam os chat_id desses, separados por virgula e opcionalmente com
     * o nome a seguir a dois pontos:
     *   VIP_CHAT_IDS=739726043:Super digital,123456:Outro
     *
     * Isto nao substitui um disco persistente — o historico da conversa nao
     * volta — mas garante que o lead volta a existir, no estagio certo, no
     * acompanhamento VIP e no topo da caixa de entrada.
     */
    VIP_CHAT_IDS: optionalString,
    /**
     * Backup da base de dados para o canal de controlo, de hora a hora.
     *
     * Ligado por omissao: enquanto o disco nao estiver montado, e a unica coisa
     * entre um deploy e perder a base de leads inteira. Desliga-se com
     * BACKUP_ENABLED=false quando houver disco a serio.
     */
    BACKUP_ENABLED: optionalString.transform((value) => value !== 'false'),
    /** Intervalo entre backups, em minutos. */
    BACKUP_INTERVAL_MINUTES: intFromString(60, 5, 1440),
    /**
     * Repor no arranque os leads que os deploys apagaram, reconstruidos a
     * partir dos logs de producao. Idempotente; desliga-se com
     * RECOVER_LEADS=false quando ja nao fizer falta.
     */
    RECOVER_LEADS: optionalString.transform((value) => value !== 'false'),
    /**
     * Link de convite do grupo VIP, entregue ao lead quando eu carrego em
     * "Aprovar". E o unico sitio do sistema onde este link sai, de proposito:
     * o acesso e uma decisao minha, tomada depois de validar o deposito.
     */
    VIP_GROUP_LINK: optionalString.transform((value) => value ?? 'https://t.me/+aTgtTQdqcThjNTk0'),
    /**
     * Ligacao ao Postgres. Definida, e o Postgres que guarda tudo: leads,
     * conversas, comprovativos, estado do remarketing. Vazia, fica o SQLite.
     *
     * E o interruptor da migracao inteira, e tambem a forma de voltar atras:
     * apagar a variavel devolve o servico ao comportamento anterior sem mexer
     * numa linha de codigo.
     *
     * Formato normal, o mesmo que o Supabase, o Neon e o Render dao:
     * postgresql://utilizador:palavra@servidor:5432/base
     */
    DATABASE_URL: optionalString,
    /**
     * Apagar as conversas todas e ficar so com as que vierem a seguir.
     *
     * Nao e um interruptor de ligar/desligar: e um valor qualquer (uma data,
     * por exemplo). Ao arrancar, se este valor for DIFERENTE do que ficou
     * guardado na base de dados, as conversas sao apagadas e o valor novo fica
     * guardado. Nos arranques seguintes os dois valores ja sao iguais e nao se
     * apaga nada.
     *
     * A diferenca entre isto e um booleano e a que impede o desastre: com
     * WIPE_CONVERSATIONS=true esquecido na plataforma, CADA deploy apagava
     * tambem as conversas novas — que sao precisamente as que se quer manter.
     *
     * Para limpar outra vez mais tarde, poe-se um valor novo.
     */
    WIPE_TOKEN: optionalString,

    // --- Caixa de entrada -------------------------------------------------
    /**
     * Palavra-passe da caixa de entrada. SEM ELA A CAIXA NAO EXISTE: as rotas
     * respondem 404, como o /stats faz quando nao ha segredo. Melhor nao haver
     * caixa nenhuma do que haver uma aberta a quem passar pelo endereco.
     */
    ADMIN_PASSWORD: optionalString,
    /**
     * Segredo partilhado entre os servicos dos dois bots. O servico que serve
     * a pagina usa-o para ler os dados do outro, sem obrigar o browser a
     * autenticar-se duas vezes nem a falar com duas origens.
     */
    INBOX_PROXY_SECRET: optionalString,
    /** Endereco do servico do Ivan, para o proxy. Vazio = so ha um bot. */
    IVAN_INBOX_URL: optionalString,
    /** Nome deste bot na caixa de entrada. */
    BOT_LABEL: optionalString,
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
  /**
   * A base de dados esta num caminho que nao sobrevive a um deploy.
   *
   * No Render o sistema de ficheiros do contentor e descartado a cada deploy:
   * sem um disco persistente montado, os leads, o historico e o estado do
   * remarketing desaparecem sem erro nenhum, e o funil recomeca do zero sem
   * ninguem dar por isso. Um erro silencioso destes custa a base de leads
   * inteira, por isso e dito em voz alta no arranque e no /health.
   */
  databaseIsEphemeral: boolean;
  /** A caixa de entrada esta utilizavel: ha palavra-passe suficientemente longa. */
  inboxEnabled: boolean;
  /** Leads que voltam sempre: aprovados e afixados a cada arranque. */
  vipLeads: Array<{ chatId: number; firstName: string | null }>;
};

/**
 * "739726043:Super digital,123456" -> lista de leads a repor no arranque.
 *
 * O nome e opcional e so serve para a conversa nao aparecer como "#739726043"
 * na caixa de entrada enquanto o lead nao voltar a escrever. Entradas sem um
 * numero valido sao ignoradas em silencio: uma variavel mal escrita nao pode
 * impedir o servico de arrancar.
 */
function parseVipLeads(raw: string | undefined): Array<{ chatId: number; firstName: string | null }> {
  if (!raw) return [];

  return raw
    .split(',')
    .map((entry) => {
      const [id, ...rest] = entry.split(':');
      const chatId = Number((id ?? '').trim());
      if (!Number.isInteger(chatId) || chatId === 0) return null;

      const firstName = rest.join(':').trim();
      return { chatId, firstName: firstName.length > 0 ? firstName : null };
    })
    .filter((lead): lead is { chatId: number; firstName: string | null } => lead !== null);
}

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
    // Um disco persistente do Render monta FORA da pasta da aplicacao
    // (/var/data, por exemplo). Um ficheiro dentro do cwd veio com o codigo e
    // vai-se embora com ele no deploy seguinte.
    // 12 caracteres e o minimo para isto nao ser adivinhavel. Abaixo disso a
    // caixa fica desligada em vez de ficar fraca.
    inboxEnabled: (value.ADMIN_PASSWORD ?? '').length >= 12,
    databaseIsEphemeral:
      databaseFile !== ':memory:' &&
      !path.relative(process.cwd(), databaseFile).startsWith('..'),
    vipLeads: parseVipLeads(value.VIP_CHAT_IDS),
  };
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';

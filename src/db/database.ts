import fs from 'node:fs';
import path from 'node:path';

import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { ehNotaInterna, eventos } from '../utils/eventos';
import { openDriver, type Driver } from './driver';
import { ehIdPersona, type IdPersona, PERSONA_HISTORICA } from '../personas/ids';
import { migrarChaves } from './chaves';

const log = createLogger('db');

/**
 * Estagios do funil. A ordem importa: `STAGE_ORDER` e usada para impedir que o
 * lead regrida de estagio por causa de uma classificacao ruidosa do Gemini.
 */
export const FUNNEL_STAGES = [
  'novo',
  'qualificacao',
  'apresentacao',
  'objecao',
  'registo_enviado',
  'registado',
  'deposito_enviado',
  'comprovativo_recebido',
  'acesso_liberado',
  'perdido',
] as const;

/**
 * Nomes anteriores dos estagios (PT-BR, antes do passo do comprovativo).
 * Sem este mapa, um lead a meio do funil voltaria a 'novo' no primeiro deploy
 * e o estrategista recomecaria a conversa do zero com quem ja estava adiantado.
 */
const LEGACY_STAGES: Record<string, FunnelStage> = {
  cadastro_enviado: 'registo_enviado',
  cadastrado: 'registado',
  depositado: 'acesso_liberado',
};

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const STAGE_ORDER = new Map<FunnelStage, number>(
  FUNNEL_STAGES.map((stage, index) => [stage, index]),
);

export type MessageRole = 'user' | 'assistant';

/**
 * Quem escreveu a mensagem, para a caixa de entrada poder distinguir.
 *
 * O `role` diz de que LADO veio; isto diz QUEM a compos. Sem esta separacao
 * nao se distingue o que a IA escreveu do que o operador escreveu a mao, e a
 * conversa fica impossivel de auditar.
 *
 * - `bot`     — a cadeia estrategista/redator, ou um texto fixo do funil
 * - `humano`  — o operador, pela caixa de entrada
 * - `sistema` — remarketing, lembretes e marcadores de acontecimentos
 */
export type MessageAuthor = 'bot' | 'humano' | 'sistema';

export interface Lead {
  chatId: number;
  /**
   * De qual dos influencers e esta conversa.
   *
   * Faz parte da identidade do lead e nao e um detalhe: junto com o chatId e o
   * que o identifica. A mesma pessoa pode ter uma conversa com cada um, e sao
   * dois leads.
   */
  persona: IdPersona;
  /** Quando o lead disse que ia tratar disto (UTC), ou null. */
  promisedAt: string | null;
  /** O que ele disse, para o lembrete nao soar generico. */
  promiseNote: string | null;
  /** Apelido, quando o Telegram o da. */
  lastName: string | null;
  /** Cantao onde vive, assim que o disser. Null enquanto nao se souber. */
  canton: string | null;
  /**
   * Afixado no topo da caixa de entrada.
   *
   * Nao muda nada no funil: e so para o lead que importa nao se perder de
   * vista entre as conversas novas que vao chegando todos os dias.
   */
  pinned: boolean;
  /**
   * Por onde e que esta conversa entra e sai: a Bot API ou a conta de
   * utilizador. Guardado por lead, e nao global, porque a passagem de um para
   * o outro e gradual — quem ja falava com o bot continua no bot.
   */
  transporte: 'bot' | 'userbot' | 'bot_ivan';
  /**
   * Como se trata este lead. Vem do perfil do Telegram ou da resposta dele.
   *
   * Os cinco campos a seguir sao o coracao da memoria do funil: cada um e uma
   * pergunta que, depois de respondida, fica PROIBIDA. Perder leads por
   * perguntar duas vezes a mesma coisa foi o que fez isto existir.
   */
  tratamento: string | null;
  /** Ja se perguntou o nome (para nao perguntar outra vez a quem nao respondeu). */
  nomePerguntado: boolean;
  /** O que o trouxe aqui, nas palavras dele. */
  atencao: string | null;
  /** Ha quanto tempo vive na Suica. */
  tempoSuica: string | null;
  /** Em que o Pedrito diz ter trabalhado com ESTE lead: obras ou restauracao. */
  oficioPedrito: string | null;
  /** "qualificado" (ja depositou) ou "nao_qualificado", posto por comando. */
  tag: string | null;
  /**
   * As perguntas que ja lhe foram feitas, respondidas ou nao.
   *
   * Sem isto, uma pergunta sem resposta util voltava: o lead respondeu "Nao
   * trabalho bro", nada ficou guardado no campo do trabalho, e o bot voltou a
   * perguntar em que area trabalhava. Quem nao responde a primeira nao quer
   * responder — insistir so mostra que ninguem esta a ler.
   */
  perguntasFeitas: string[];
  /**
   * Em que trabalha, nas palavras dele. Null enquanto nao se souber.
   *
   * Ao contrario do cantao e da experiencia, nao ha detector em codigo: uma
   * profissao e texto aberto e uma lista fechada nunca a apanharia. Quem
   * garante que a pergunta nao se repete e esta coluna, nao a deteccao.
   */
  job: string | null;
  /**
   * Se ja aposta ou se esta a comecar. Null enquanto nao se souber.
   *
   * Guardado pela mesma razao do cantao: e este campo, e nao a memoria do
   * modelo, que impede a pergunta de voltar a ser feita.
   */
  bettingExperience: string | null;
  firstName: string | null;
  username: string | null;
  languageCode: string | null;
  stage: FunnelStage;
  notes: string | null;
  messageCount: number;
  /** O operador assumiu a conversa: a IA nao responde a este lead. */
  humanHandover: boolean;
  /** O lead bloqueou o bot. */
  blocked: boolean;
  /** Quantos toques de remarketing ja levou. */
  remarketingTouches: number;
  /** Ultimo toque de remarketing, ou null. */
  lastRemarketingAt: string | null;
  /** Respondeu a um toque e saiu da campanha. */
  remarketingCancelled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: number;
  chatId: number;
  role: MessageRole;
  author: MessageAuthor;
  content: string;
  /** file_id do Telegram, quando a mensagem leva uma imagem. */
  mediaFileId: string | null;
  /** Por agora so "photo". Fica como campo para nao ter de migrar outra vez. */
  mediaKind: string | null;
  directive: string | null;
  createdAt: string;
}

/**
 * Estagios que contam como conversao para efeitos de aprendizagem: o lead
 * chegou ao deposito. Antes disso nao ha prova de que a abordagem resultou.
 */
export const CONVERTED_STAGES: readonly FunnelStage[] = [
  'deposito_enviado',
  'comprovativo_recebido',
  'acesso_liberado',
];

/** Uma abordagem que ja levou um lead ate ao deposito. */
export interface PlaybookEntry {
  profile: string;
  objection: string;
  directive: string;
  cta: string;
}

/** Comprovativo de deposito enviado pelo lead, a espera de validacao humana. */
export interface DepositProof {
  id: number;
  chatId: number;
  leadName: string | null;
  username: string | null;
  fileId: string;
  messageId: number | null;
  status: 'pendente' | 'aprovado' | 'recusado';
  createdAt: string;
}

/** Publicos do remarketing: quem ainda nao depositou, e quem ja esta no VIP. */
export type RemarketingAudience = 'nao_convertido' | 'vip' | 'promessa' | 'link_parado';

export interface FunnelStats {
  totalLeads: number;
  totalMessages: number;
  byStage: Record<string, number>;
  /** Comprovativos a espera de alguem os validar. */
  pendingProofs: number;
  /** Leads que prometeram depositar e ainda nao foram lembrados. */
  pendingPromises: number;
}

interface LeadRow {
  chat_id: number;
  promised_at: string | null;
  promise_note: string | null;
  canton: string | null;
  last_name: string | null;
  pinned: number;
  transporte: string | null;
  persona: string | null;
  tratamento: string | null;
  nome_perguntado: number;
  atencao: string | null;
  tempo_suica: string | null;
  oficio_pedrito: string | null;
  tag: string | null;
  perguntas_feitas: string | null;
  job: string | null;
  betting_experience: string | null;
  first_name: string | null;
  username: string | null;
  language_code: string | null;
  stage: string;
  notes: string | null;
  message_count: number;
  human_handover: number;
  blocked: number;
  remarketing_touches: number;
  last_remarketing_at: string | null;
  remarketing_cancelled: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  chat_id: number;
  role: string;
  author: string | null;
  content: string;
  media_file_id: string | null;
  media_kind: string | null;
  directive: string | null;
  created_at: string;
}

function ensureDirectory(file: string): void {
  if (file === ':memory:') return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * A ligacao activa. Fica preenchida pelo initDatabase(), que corre no arranque
 * antes de qualquer outra coisa tocar na base de dados.
 *
 * Nao e criada aqui em cima de proposito: abrir uma ligacao de rede no momento
 * em que o modulo e importado obrigava tudo o que o importa a saber esperar, e
 * nem sempre ha por quem esperar (um script, um teste, o /health).
 */
let driver: Driver | null = null;

/** Acesso interno, com erro claro se alguem se esquecer de inicializar. */
function conn(): Driver {
  if (!driver) {
    throw new Error(
      'base de dados nao inicializada: chama initDatabase() antes de a usar.',
    );
  }
  return driver;
}

/** Em que motor estamos, para quem precise de decidir (o backup, por exemplo). */
export function databaseDialect(): 'sqlite' | 'postgres' {
  return conn().dialect;
}

/**
 * Esquema, por dialecto.
 *
 * Os chat_id do Telegram passam dos 2^31 (ha ids como 8962954467), portanto no
 * Postgres tem de ser BIGINT. Com INTEGER a insercao rebentava em producao com
 * leads novos e ninguem perceberia porque.
 *
 * As datas ficam como TEXTO "YYYY-MM-DD HH:MM:SS" em UTC nos dois motores, que
 * e o formato que o SQLite ja usava. Assim todo o codigo que le, compara e
 * ordena datas continua igual.
 */
/*
 * As mensagens e os comprovativos deixaram de declarar uma chave estrangeira
 * para leads(chat_id).
 *
 * Nao foi por gosto: a chave primaria dos leads e agora (chat_id, persona) — o
 * mesmo chat_id existe duas vezes quando a mesma pessoa escreve aos dois bots —
 * e uma chave estrangeira precisa de apontar para algo UNICO. Apontar so para o
 * chat_id deixou de ser possivel, e no Postgres o CREATE TABLE recusava.
 *
 * Passar a apontar para as duas colunas era possivel, mas obrigava a persona a
 * estar escrita nas duas pontas antes de qualquer insercao, e uma mensagem que
 * chegue antes de o lead estar gravado passava a rebentar em vez de esperar. A
 * integridade fica do lado do codigo, que nunca grava uma mensagem sem o lead.
 */
const DDL: Record<'sqlite' | 'postgres', string[]> = {
  sqlite: [
    `CREATE TABLE IF NOT EXISTS leads (
      chat_id       INTEGER NOT NULL,
      persona       TEXT NOT NULL DEFAULT 'el_pedrito',
      first_name    TEXT,
      username      TEXT,
      language_code TEXT,
      stage         TEXT NOT NULL DEFAULT 'novo',
      notes         TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, persona)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    INTEGER NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      directive  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS deposit_proofs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     INTEGER NOT NULL,
      lead_name   TEXT,
      username    TEXT,
      file_id     TEXT NOT NULL,
      message_id  INTEGER,
      status      TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'aprovado', 'recusado')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS processed_updates (
      update_id  INTEGER NOT NULL,
      bot        TEXT NOT NULL DEFAULT 'el_pedrito',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (update_id, bot)
    )`,
    `CREATE TABLE IF NOT EXISTS remarketing_runs (
      slot       TEXT NOT NULL,
      run_date   TEXT NOT NULL,
      audience   TEXT NOT NULL,
      sent       INTEGER NOT NULL DEFAULT 0,
      persona    TEXT NOT NULL DEFAULT 'el_pedrito',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (slot, run_date, audience, persona)
    )`,
    `CREATE TABLE IF NOT EXISTS app_meta (
      chave      TEXT PRIMARY KEY,
      valor      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ],
  postgres: [
    `CREATE TABLE IF NOT EXISTS leads (
      chat_id       BIGINT NOT NULL,
      persona       TEXT NOT NULL DEFAULT 'el_pedrito',
      first_name    TEXT,
      username      TEXT,
      language_code TEXT,
      stage         TEXT NOT NULL DEFAULT 'novo',
      notes         TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (chat_id, persona)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id         BIGSERIAL PRIMARY KEY,
      chat_id    BIGINT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      directive  TEXT,
      created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS deposit_proofs (
      id          BIGSERIAL PRIMARY KEY,
      chat_id     BIGINT NOT NULL,
      lead_name   TEXT,
      username    TEXT,
      file_id     TEXT NOT NULL,
      message_id  BIGINT,
      status      TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'aprovado', 'recusado')),
      created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS processed_updates (
      update_id  BIGINT NOT NULL,
      bot        TEXT NOT NULL DEFAULT 'el_pedrito',
      created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (update_id, bot)
    )`,
    `CREATE TABLE IF NOT EXISTS remarketing_runs (
      slot       TEXT NOT NULL,
      run_date   TEXT NOT NULL,
      audience   TEXT NOT NULL,
      sent       INTEGER NOT NULL DEFAULT 0,
      persona    TEXT NOT NULL DEFAULT 'el_pedrito',
      created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (slot, run_date, audience, persona)
    )`,
    `CREATE TABLE IF NOT EXISTS app_meta (
      chave      TEXT PRIMARY KEY,
      valor      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    )`,
  ],
};

const INDICES = [
  'CREATE INDEX IF NOT EXISTS idx_proofs_status ON deposit_proofs (status, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads (stage)',
];

/**
 * Colunas acrescentadas depois da primeira versao.
 *
 * O SQLite nao tem ADD COLUMN IF NOT EXISTS e obriga a perguntar primeiro; o
 * Postgres tem, e resolve-se numa linha. A lista e a mesma para os dois, para
 * nao haver duas verdades sobre o que a tabela tem.
 */
const COLUNAS: Array<{ tabela: string; coluna: string; sqlite: string; postgres: string }> = [
  { tabela: 'leads', coluna: 'last_remarketing_at', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'remarketing_touches', sqlite: 'INTEGER NOT NULL DEFAULT 0', postgres: 'INTEGER NOT NULL DEFAULT 0' },
  { tabela: 'leads', coluna: 'blocked', sqlite: 'INTEGER NOT NULL DEFAULT 0', postgres: 'INTEGER NOT NULL DEFAULT 0' },
  { tabela: 'leads', coluna: 'promised_at', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'promise_note', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'canton', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'remarketing_cancelled', sqlite: 'INTEGER NOT NULL DEFAULT 0', postgres: 'INTEGER NOT NULL DEFAULT 0' },
  { tabela: 'leads', coluna: 'betting_experience', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'human_handover', sqlite: 'INTEGER NOT NULL DEFAULT 0', postgres: 'INTEGER NOT NULL DEFAULT 0' },
  { tabela: 'leads', coluna: 'job', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'pinned', sqlite: 'INTEGER NOT NULL DEFAULT 0', postgres: 'INTEGER NOT NULL DEFAULT 0' },
  { tabela: 'leads', coluna: 'last_name', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'transporte', sqlite: "TEXT NOT NULL DEFAULT 'bot'", postgres: "TEXT NOT NULL DEFAULT 'bot'" },
  // --- Factos do lead: cada um destes e uma pergunta que NUNCA se repete ---
  { tabela: 'leads', coluna: 'tratamento', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'nome_perguntado', sqlite: 'INTEGER NOT NULL DEFAULT 0', postgres: 'INTEGER NOT NULL DEFAULT 0' },
  { tabela: 'leads', coluna: 'atencao', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'tempo_suica', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'oficio_pedrito', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'tag', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'leads', coluna: 'perguntas_feitas', sqlite: 'TEXT', postgres: 'TEXT' },
  // --- De quem e este lead: entra na chave primaria, por isso nunca e nulo ---
  //
  // O DEFAULT trata dos leads que ja estao na base de dados: sao todos do El
  // Pedrito, que era o unico influencer quando foram criados.
  { tabela: 'leads', coluna: 'persona', sqlite: "TEXT NOT NULL DEFAULT 'el_pedrito'", postgres: "TEXT NOT NULL DEFAULT 'el_pedrito'" },
  { tabela: 'messages', coluna: 'persona', sqlite: "TEXT NOT NULL DEFAULT 'el_pedrito'", postgres: "TEXT NOT NULL DEFAULT 'el_pedrito'" },
  { tabela: 'deposit_proofs', coluna: 'persona', sqlite: "TEXT NOT NULL DEFAULT 'el_pedrito'", postgres: "TEXT NOT NULL DEFAULT 'el_pedrito'" },
  { tabela: 'remarketing_runs', coluna: 'persona', sqlite: "TEXT NOT NULL DEFAULT 'el_pedrito'", postgres: "TEXT NOT NULL DEFAULT 'el_pedrito'" },
  // Qual dos bots entregou este update. Sem isto, as sequencias de update_id
  // dos dois bots colidem e o segundo update e descartado como repetido.
  { tabela: 'processed_updates', coluna: 'bot', sqlite: "TEXT NOT NULL DEFAULT 'el_pedrito'", postgres: "TEXT NOT NULL DEFAULT 'el_pedrito'" },
  { tabela: 'messages', coluna: 'author', sqlite: "TEXT NOT NULL DEFAULT 'bot'", postgres: "TEXT NOT NULL DEFAULT 'bot'" },
  { tabela: 'messages', coluna: 'media_file_id', sqlite: 'TEXT', postgres: 'TEXT' },
  { tabela: 'messages', coluna: 'media_kind', sqlite: 'TEXT', postgres: 'TEXT' },
];

async function addColumnIfMissing(
  tabela: string,
  coluna: string,
  definicao: string,
): Promise<void> {
  const d = conn();

  if (d.dialect === 'postgres') {
    await d.exec(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS ${coluna} ${definicao}`);
    return;
  }

  const columns = await d.all<{ name: string }>(`PRAGMA table_info(${tabela})`);
  if (columns.some((entry) => entry.name === coluna)) return;

  await d.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  log.info(`migracao: ${tabela}.${coluna} adicionada`);
}

/**
 * Abre a base de dados e poe o esquema em dia.
 *
 * Tem de ser chamada uma vez, no arranque, antes de qualquer leitura ou
 * escrita. E idempotente: correr duas vezes nao faz mal nenhum.
 */
export async function initDatabase(): Promise<void> {
  if (driver) return;

  ensureDirectory(env.databaseFile);

  driver = await openDriver({
    databaseUrl: env.DATABASE_URL ?? null,
    sqliteFile: env.databaseFile,
  });

  const dialecto = driver.dialect;

  for (const tabela of DDL[dialecto]) {
    await driver.exec(tabela);
  }

  for (const { tabela, coluna, sqlite, postgres } of COLUNAS) {
    await addColumnIfMissing(tabela, coluna, dialecto === 'postgres' ? postgres : sqlite);
  }

  // Depois das colunas e antes dos indices: uma chave nao pode apontar para uma
  // coluna que ainda nao existe, e um indice criado antes da reconstrucao da
  // tabela desaparecia com ela.
  await migrarChaves(driver);

  for (const indice of INDICES) {
    await driver.exec(indice);
  }

  log.info(
    dialecto === 'postgres'
      ? 'Postgres pronto'
      : `SQLite pronto em ${env.databaseFile}`,
  );
}

/**
 * O node:sqlite nao tem o helper `transaction()` do better-sqlite3, entao a
 * transacao e explicita. Sem ela, uma falha entre inserir a mensagem e somar
 * o contador do lead deixaria os dois fora de sincronia.
 */
async function inTransaction<T>(run: (tx: Driver) => Promise<T>): Promise<T> {
  return conn().transaction(run);
}

/**
 * O node:sqlite tipa toda linha como Record<string, SQLOutputValue>. A forma
 * real de cada tabela e conhecida pelo schema logo acima, e os mapeadores
 * abaixo (mapLead/mapMessage) sao o unico lugar que le esses campos — entao a
 * conversao fica concentrada aqui em vez de espalhada por cada consulta.
 */
function asRow<T>(value: unknown): T | undefined {
  return value as T | undefined;
}

function asRows<T>(value: unknown): T[] {
  return value as T[];
}

function toStage(value: string): FunnelStage {
  if (STAGE_ORDER.has(value as FunnelStage)) return value as FunnelStage;
  return LEGACY_STAGES[value] ?? 'novo';
}

function mapLead(row: LeadRow): Lead {
  return {
    chatId: row.chat_id,
    // Uma coluna de texto pode trazer qualquer coisa; um valor que nao seja um
    // influencer conhecido fica no historico em vez de contaminar o funil.
    persona: ehIdPersona(row.persona) ? row.persona : PERSONA_HISTORICA,
    promisedAt: row.promised_at,
    promiseNote: row.promise_note,
    canton: row.canton,
    lastName: row.last_name,
    pinned: row.pinned === 1,
    transporte:
      row.transporte === 'userbot' || row.transporte === 'bot_ivan' ? row.transporte : 'bot',
    tratamento: row.tratamento,
    nomePerguntado: row.nome_perguntado === 1,
    atencao: row.atencao,
    tempoSuica: row.tempo_suica,
    oficioPedrito: row.oficio_pedrito,
    tag: row.tag,
    perguntasFeitas: (row.perguntas_feitas ?? '').split(',').filter(Boolean),
    job: row.job,
    bettingExperience: row.betting_experience,
    firstName: row.first_name,
    username: row.username,
    languageCode: row.language_code,
    stage: toStage(row.stage),
    notes: row.notes,
    messageCount: row.message_count,
    humanHandover: row.human_handover === 1,
    blocked: row.blocked === 1,
    remarketingTouches: row.remarketing_touches,
    lastRemarketingAt: row.last_remarketing_at,
    remarketingCancelled: row.remarketing_cancelled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    // Linhas gravadas antes da coluna existir ficam com NULL e sao do bot.
    author: row.author === 'humano' || row.author === 'sistema' ? row.author : 'bot',
    content: row.content,
    mediaFileId: row.media_file_id,
    mediaKind: row.media_kind,
    directive: row.directive,
    createdAt: row.created_at,
  };
}

const SQL = {
  // A persona entra na insercao E no alvo do conflito: a chave e (chat_id,
  // persona), e um ON CONFLICT(chat_id) sozinho deixou de corresponder a
  // restricao nenhuma.
  //
  // O DO UPDATE nao mexe na persona de proposito. Ela e escrita uma vez, na
  // criacao, e nunca mais: um lead nao troca de influencer a meio de uma
  // conversa, e se algum dia uma chamada vier com a persona errada e melhor
  // que nao aconteca nada do que o lead mudar de dono em silencio.
  upsertLead: `
    INSERT INTO leads (chat_id, persona, first_name, username, language_code)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, persona) DO UPDATE SET
      first_name    = COALESCE(excluded.first_name, leads.first_name),
      username      = COALESCE(excluded.username, leads.username),
      language_code = COALESCE(excluded.language_code, leads.language_code),
      updated_at    = datetime('now')
  `,
  getLead: 'SELECT * FROM leads WHERE chat_id = ? AND persona = ?',
  getLeadQualquerPersona: 'SELECT * FROM leads WHERE chat_id = ?',
  updateStage: `
    UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE chat_id = ? AND persona = ?
  `,
  updateNotes: `
    UPDATE leads SET notes = ?, updated_at = datetime('now') WHERE chat_id = ? AND persona = ?
  `,
  bumpMessageCount: `
    UPDATE leads
       SET message_count = message_count + 1,
           updated_at    = datetime('now')
     WHERE chat_id = ? AND persona = ?
  `,
  insertMessage: `
    INSERT INTO messages (chat_id, persona, role, author, content, media_file_id, media_kind, directive)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  /**
   * Lista para a caixa de entrada: o lead, a ultima mensagem e quando foi.
   *
   * As queries que ja existiam (targetsNotConverted, targetsVip, duePromises)
   * trazem filtros de remarketing embutidos e nao servem aqui: a caixa de
   * entrada quer TODOS os leads, bloqueados e convertidos incluidos.
   *
   * O filtro de texto e sempre passado; quando vem vazio, o LIKE '%%' deixa
   * passar tudo, o que evita ter duas variantes da mesma query.
   */
  inboxLeads: `
    SELECT * FROM (
    SELECT l.*,
           -- A pre-visualizacao ignora as NOTAS INTERNAS, e nao tudo o que
           -- tem author 'sistema'. A diferenca importa: uma nota interna e
           -- gravada do lado do lead (role='user') sem ele ter escrito nada;
           -- a mensagem do remarketing e a de boas-vindas ao VIP tambem sao
           -- 'sistema', mas foram MESMO enviadas e tem de aparecer.
           (SELECT content    FROM messages m WHERE m.chat_id = l.chat_id AND m.persona = l.persona AND NOT (m.role = 'user' AND m.author = 'sistema' AND m.media_file_id IS NULL) ORDER BY m.id DESC LIMIT 1) AS last_content,
           (SELECT role       FROM messages m WHERE m.chat_id = l.chat_id AND m.persona = l.persona AND NOT (m.role = 'user' AND m.author = 'sistema' AND m.media_file_id IS NULL) ORDER BY m.id DESC LIMIT 1) AS last_role,
           (SELECT created_at FROM messages m WHERE m.chat_id = l.chat_id AND m.persona = l.persona AND NOT (m.role = 'user' AND m.author = 'sistema' AND m.media_file_id IS NULL) ORDER BY m.id DESC LIMIT 1) AS last_at,
           (SELECT id         FROM messages m WHERE m.chat_id = l.chat_id AND m.persona = l.persona ORDER BY m.id DESC LIMIT 1) AS last_id
      FROM leads l
     WHERE l.persona = ?
       AND (? = '' OR lower(coalesce(l.first_name, '') || ' ' || coalesce(l.username, '')) LIKE '%' || ? || '%')
       AND (? = '' OR l.stage = ?)
    ) t
     -- O created_at so tem precisao ao segundo, portanto duas conversas
     -- activas no mesmo segundo empatam. O id da mensagem e estritamente
     -- crescente e desempata sempre pela mais recente.
     -- Afixados primeiro, e so depois a ordem normal por actividade.
     ORDER BY t.pinned DESC, coalesce(t.last_at, t.updated_at) DESC, coalesce(t.last_id, 0) DESC
     LIMIT ? OFFSET ?
  `,
  countInboxLeads: `
    SELECT COUNT(*) AS total
      FROM leads l
     WHERE l.persona = ?
       AND (? = '' OR lower(coalesce(l.first_name, '') || ' ' || coalesce(l.username, '')) LIKE '%' || ? || '%')
       AND (? = '' OR l.stage = ?)
  `,
  /**
   * Historico completo, paginado para tras a partir de um id.
   *
   * O getRecentMessages so devolve a janela de memoria das IAs (tecto de 100);
   * aqui quer-se a conversa toda, que pode ser bem maior.
   */
  messagesPage: `
    SELECT * FROM (
      SELECT * FROM messages
       WHERE chat_id = ? AND persona = ? AND (? = 0 OR id < ?)
       ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `,
  setHandover: `
    UPDATE leads SET human_handover = ?, updated_at = datetime('now') WHERE chat_id = ? AND persona = ?
  `,
  recentMessages: `
    SELECT * FROM (
      SELECT * FROM messages WHERE chat_id = ? AND persona = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `,
  deleteMessages: 'DELETE FROM messages WHERE chat_id = ? AND persona = ?',
  deleteLead: 'DELETE FROM leads WHERE chat_id = ? AND persona = ?',
  countLeads: 'SELECT COUNT(*) AS total FROM leads WHERE persona = ?',
  countMessages: 'SELECT COUNT(*) AS total FROM messages WHERE persona = ?',
  countByStage: 'SELECT stage, COUNT(*) AS total FROM leads WHERE persona = ? GROUP BY stage',
  insertProof: `
    INSERT INTO deposit_proofs (chat_id, persona, lead_name, username, file_id, message_id)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `,
  countPendingProofs: "SELECT COUNT(*) AS total FROM deposit_proofs WHERE persona = ? AND status = 'pendente'",
  deleteProofs: 'DELETE FROM deposit_proofs WHERE chat_id = ? AND persona = ?',
  claimSlot: `
    INSERT INTO remarketing_runs (slot, run_date, audience, persona) VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `,
  recordSlotSent: `
    UPDATE remarketing_runs SET sent = ?
     WHERE slot = ? AND run_date = ? AND audience = ? AND persona = ?
  `,
  markRemarketed: `
    UPDATE leads
       SET last_remarketing_at = datetime('now'),
           remarketing_touches = remarketing_touches + 1
     WHERE chat_id = ? AND persona = ?
  `,
  markBlocked: "UPDATE leads SET blocked = 1 WHERE chat_id = ? AND persona = ?",
  cancelRemarketing: `
    UPDATE leads
       SET remarketing_cancelled = 1
     WHERE chat_id = ? AND persona = ?
       -- So conta como resposta AO remarketing. Quem escreve antes de ter
       -- levado algum toque esta so a conversar, e continua elegivel se
       -- depois arrefecer.
       AND last_remarketing_at IS NOT NULL
       AND remarketing_cancelled = 0
  `,
  claimUpdate: 'INSERT INTO processed_updates (update_id, bot) VALUES (?, ?) ON CONFLICT DO NOTHING',
  pruneUpdates: `
    DELETE FROM processed_updates
     WHERE update_id NOT IN (
       SELECT update_id FROM processed_updates ORDER BY update_id DESC LIMIT ?
     )
  `,
  setCanton: `
    UPDATE leads SET canton = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND persona = ? AND (canton IS NULL OR canton = '')
  `,
  setPinned: 'UPDATE leads SET pinned = ? WHERE chat_id = ? AND persona = ?',
  setTransporte: 'UPDATE leads SET transporte = ? WHERE chat_id = ? AND persona = ?',
  setTag: "UPDATE leads SET tag = ?, updated_at = datetime('now') WHERE chat_id = ? AND persona = ?",
  // Todos com a mesma guarda do setJob: a PRIMEIRA resposta e a que fica. Um
  // lead que se contradiz mais a frente nao faz o funil esquecer o que ele
  // disse primeiro, e uma escrita repetida nao apaga o que ja la estava.
  setTratamento: `
    UPDATE leads SET tratamento = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND persona = ? AND (tratamento IS NULL OR tratamento = '')
  `,
  setAtencao: `
    UPDATE leads SET atencao = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND persona = ? AND (atencao IS NULL OR atencao = '')
  `,
  setTempoSuica: `
    UPDATE leads SET tempo_suica = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND persona = ? AND (tempo_suica IS NULL OR tempo_suica = '')
  `,
  setOficioPedrito: `
    UPDATE leads SET oficio_pedrito = ?
     WHERE chat_id = ? AND persona = ? AND (oficio_pedrito IS NULL OR oficio_pedrito = '')
  `,
  setNomePerguntado: 'UPDATE leads SET nome_perguntado = 1 WHERE chat_id = ? AND persona = ?',
  // Acrescenta a chave a lista sem a duplicar. Feito em SQL e nao em codigo
  // para dois turnos em paralelo nao se sobreporem um ao outro.
  marcarPergunta: `
    UPDATE leads
       SET perguntas_feitas = CASE
             WHEN perguntas_feitas IS NULL OR perguntas_feitas = '' THEN ?
             WHEN ',' || perguntas_feitas || ',' LIKE '%,' || ? || ',%' THEN perguntas_feitas
             ELSE perguntas_feitas || ',' || ?
           END
     WHERE chat_id = ? AND persona = ?
  `,
  setIdentity: `
    UPDATE leads
       SET first_name = coalesce(?, first_name),
           last_name = coalesce(?, last_name),
           username = coalesce(?, username)
     WHERE chat_id = ? AND persona = ?
  `,
  leadsWithoutName: `
    SELECT chat_id FROM leads
     WHERE persona = ?
       AND (first_name IS NULL OR first_name = '')
       AND blocked = 0
     ORDER BY updated_at DESC
     LIMIT ?
  `,
  setStage: "UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE chat_id = ? AND persona = ?",
  setJob: `
    UPDATE leads SET job = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND persona = ? AND (job IS NULL OR job = '')
  `,
  setBettingExperience: `
    UPDATE leads SET betting_experience = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND persona = ? AND (betting_experience IS NULL OR betting_experience = '')
  `,
  setPromise: `
    UPDATE leads SET promised_at = ?, promise_note = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND persona = ?
  `,
  clearPromise: 'UPDATE leads SET promised_at = NULL, promise_note = NULL WHERE chat_id = ? AND persona = ?',
  duePromises: `
    SELECT * FROM leads
     WHERE persona = ?
       AND blocked = 0
       AND promised_at IS NOT NULL
       AND promised_at <= ?
       AND stage NOT IN ('perdido', ${CONVERTED_STAGES.map((stage) => `'${stage}'`).join(', ')})
     ORDER BY promised_at ASC
     LIMIT ?
  `,
  countPromises: 'SELECT COUNT(*) AS total FROM leads WHERE persona = ? AND promised_at IS NOT NULL',
  /**
   * Lead que recebeu o link e ficou calado.
   *
   * E o balde mais quente do funil e o que mais se perde: ele ja disse que sim,
   * ja tem a pagina, e travou em alguma coisa. Esperar as 24h do toque normal e
   * chegar tarde. Por isso tem lista propria, com janela propria.
   */
  targetsLinkParado: `
    SELECT * FROM leads
     WHERE persona = ?
       AND blocked = 0
       AND remarketing_cancelled = 0
       -- Conversa levada a mao: quem manda nela sou eu, e um guiao automatico
       -- por cima do que eu escrevi e o que faz o lead perceber que ha um bot.
       AND human_handover = 0
       AND stage IN ('registo_enviado', 'registado')
       AND remarketing_touches = 0
       AND promised_at IS NULL
       AND updated_at <= datetime('now', ?)
     ORDER BY updated_at ASC
     LIMIT ?
  `,
  targetsNotConverted: `
    SELECT * FROM leads
     WHERE persona = ?
       AND blocked = 0
       -- Ja respondeu a um toque: a campanha acabou para ele.
       AND remarketing_cancelled = 0
       -- Conversa levada a mao: nao entra em campanha nenhuma.
       AND human_handover = 0
       AND stage NOT IN ('perdido', ${CONVERTED_STAGES.map((stage) => `'${stage}'`).join(', ')})
       -- Toque exacto, e nao "menos de N": cada toque tem texto proprio, e a
       -- lista de um toque nao pode levar a mensagem do outro.
       AND remarketing_touches = ?
       -- Quem prometeu ja tem lembrete proprio marcado; dois no mesmo dia
       -- e que fazem a pessoa bloquear o bot.
       AND promised_at IS NULL
       AND updated_at <= datetime('now', ?)
       AND (last_remarketing_at IS NULL OR last_remarketing_at <= datetime('now', ?))
     ORDER BY updated_at ASC
     LIMIT ?
  `,
  targetsVip: `
    SELECT * FROM leads
     WHERE persona = ?
       AND blocked = 0
       -- Conversa levada a mao: nao entra em campanha nenhuma.
       AND human_handover = 0
       AND stage IN (${CONVERTED_STAGES.map((stage) => `'${stage}'`).join(', ')})
       AND (last_remarketing_at IS NULL OR last_remarketing_at <= datetime('now', ?))
     ORDER BY updated_at ASC
     LIMIT ?
  `,
  convertedDirectives: `
    SELECT m.directive AS directive
      FROM messages m
      JOIN leads l ON l.chat_id = m.chat_id
     WHERE l.stage IN (${CONVERTED_STAGES.map(() => '?').join(', ')})
       AND m.role = 'assistant'
       AND m.directive IS NOT NULL
       AND m.chat_id <> ?
     ORDER BY m.id DESC
     LIMIT ?
  `,
};

/**
 * Abordagens que ja levaram leads ate ao deposito, para o estrategista as
 * reaproveitar. Le as diretrizes gravadas nas conversas convertidas — e por
 * isso que cada resposta guarda o JSON da diretriz que a gerou.
 *
 * Fica deduplicado por objecao: dez diretrizes a responder a mesma duvida
 * ensinam o mesmo e so gastam contexto. O proprio lead e excluido, para o
 * estrategista nao aprender com aquilo que acabou de dizer.
 */
export async function getConversionPlaybook(params: {
  excludeChatId: number;
  limit?: number;
}): Promise<PlaybookEntry[]> {
  const limit = params.limit ?? 6;

  // Le mais do que precisa porque a deduplicacao por objecao descarta muitas.
  const rows = asRows<{ directive: string }>(
    await conn().all(SQL.convertedDirectives, [...CONVERTED_STAGES, params.excludeChatId, limit * 8]),
  );

  const seen = new Set<string>();
  const playbook: PlaybookEntry[] = [];

  for (const row of rows) {
    if (playbook.length >= limit) break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.directive) as Record<string, unknown>;
    } catch {
      continue;
    }

    const objection = typeof parsed.objection === 'string' ? parsed.objection.trim() : '';
    const directive = typeof parsed.directive === 'string' ? parsed.directive.trim() : '';

    // Sem objecao nao ha licao: e so o funil a andar para a frente sozinho.
    if (!directive || !objection || objection.toLowerCase() === 'nenhuma') continue;

    const profile = typeof parsed.profile === 'string' ? parsed.profile : 'indefinido';
    const key = `${profile}|${objection.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    playbook.push({
      profile,
      objection,
      directive,
      cta: typeof parsed.cta === 'string' ? parsed.cta : '',
    });
  }

  return playbook;
}

/**
 * Guarda o comprovativo enviado pelo lead. Nao aprova nada: o registo fica
 * pendente para uma pessoa validar, que e a regra do funil — o bot nunca
 * liberta acesso sozinho.
 */
export async function recordDepositProof(input: {
  chatId: number;
  /** De quem e este lead. Sem omissao: ver upsertLead. */
  persona: IdPersona;
  leadName: string | null;
  username: string | null;
  fileId: string;
  messageId: number | null;
}): Promise<DepositProof> {
  // RETURNING em vez do lastInsertRowid: e a unica forma que funciona nos dois
  // motores, e o SQLite suporta-a desde a 3.35.
  const criado = await conn().get<{ id: number }>(SQL.insertProof, [
    input.chatId,
    input.persona,
    input.leadName,
    input.username,
    input.fileId,
    input.messageId,
  ]);

  return {
    id: Number(criado?.id ?? 0),
    chatId: input.chatId,
    leadName: input.leadName,
    username: input.username,
    fileId: input.fileId,
    messageId: input.messageId,
    status: 'pendente',
    createdAt: new Date().toISOString(),
  };
}

/** Cria o lead se ele ainda nao existir e devolve o registro atualizado. */
export async function upsertLead(input: {
  chatId: number;
  /**
   * De quem e este lead. Obrigatorio, e sem valor por omissao de proposito:
   * uma persona escolhida por omissao e a forma mais facil de um lead acabar
   * atendido pelo influencer errado. Assim o compilador obriga cada sitio a
   * dizer de quem esta a falar.
   */
  persona: IdPersona;
  firstName?: string | null;
  username?: string | null;
  languageCode?: string | null;
}): Promise<Lead> {
  const chave = [input.chatId, input.persona];

  // Saber se ja existia ANTES de escrever: e o que distingue um lead novo, que
  // tem de aparecer na caixa de entrada na hora, de uma actualizacao de quem
  // ja la esta.
  const existia = asRow<LeadRow>(await conn().get(SQL.getLead, chave)) !== undefined;

  await conn().run(SQL.upsertLead, [input.chatId,
    input.persona,
    input.firstName ?? null,
    input.username ?? null,
    input.languageCode ?? null,]);

  const row = asRow<LeadRow>(await conn().get(SQL.getLead, chave));

  if (!row) {
    throw new Error(`Falha ao persistir o lead ${input.chatId}`);
  }

  const lead = mapLead(row);

  if (!existia) {
    eventos.emitir('lead-novo', {
      chatId: lead.chatId,
      firstName: lead.firstName,
      lastName: lead.lastName,
      username: lead.username,
      stage: lead.stage,
    });
  }

  return lead;
}

/**
 * O lead de uma pessoa NUM dos influencers.
 *
 * A persona e obrigatoria porque a chave e composta: a mesma pessoa pode ter
 * uma conversa com cada bot, e uma busca so pelo chat_id devolveria uma das
 * duas a sorte — provavelmente a mais antiga. Uma resposta escrita com base no
 * lead errado seria a mistura de personalidades a acontecer pela porta de
 * tras, sem erro nenhum a assinalar.
 */
export async function getLead(chatId: number, persona: IdPersona): Promise<Lead | null> {
  const row = asRow<LeadRow>(await conn().get(SQL.getLead, [chatId, persona]));
  return row ? mapLead(row) : null;
}

/**
 * As conversas desta pessoa em TODOS os influencers.
 *
 * Serve a quem tem um chat_id e nao sabe de quem e — o caso real e uma resposta
 * manual do painel e a resolucao do transporte. Devolve tudo em vez de escolher,
 * porque escolher sem saber e exactamente o que nao se pode fazer aqui.
 */
export async function leadsDoChat(chatId: number): Promise<Lead[]> {
  const linhas = await conn().all<LeadRow>(SQL.getLeadQualquerPersona, [chatId]);
  return linhas.map(mapLead);
}

/**
 * Avanca o estagio do lead. Retrocessos sao ignorados — a unica excecao e
 * `perdido`, que pode ser marcado a qualquer momento (opt-out do lead).
 */
export async function advanceStage(chatId: number,
  persona: IdPersona, next: FunnelStage): Promise<FunnelStage> {
  const lead = await getLead(chatId, persona);
  const current = lead?.stage ?? 'novo';

  if (next === current) return current;

  if (next !== 'perdido' && current !== 'perdido') {
    const currentIndex = STAGE_ORDER.get(current) ?? 0;
    const nextIndex = STAGE_ORDER.get(next) ?? 0;
    if (nextIndex < currentIndex) return current;
  }

  await conn().run(SQL.updateStage, [next, chatId, persona]);
  return next;
}

export async function setNotes(chatId: number,
  persona: IdPersona, notes: string | null): Promise<void> {
  await conn().run(SQL.updateNotes, [notes, chatId, persona]);
}

export async function addMessage(input: {
  chatId: number;
  /** De quem e este lead. Sem omissao: ver upsertLead. */
  persona: IdPersona;
  role: MessageRole;
  content: string;
  directive?: string | null;
  /** Omitido significa `bot`, que era o unico caso antes desta coluna existir. */
  author?: MessageAuthor;
  /** file_id do Telegram, quando a mensagem leva uma imagem. */
  mediaFileId?: string | null;
  mediaKind?: string | null;
}): Promise<void> {
  await inTransaction(async () => {
    await conn().run(SQL.insertMessage, [input.chatId,
      input.persona,
      input.role,
      input.author ?? 'bot',
      input.content,
      input.mediaFileId ?? null,
      input.mediaKind ?? (input.mediaFileId ? 'photo' : null),
      input.directive ?? null,]);
    await conn().run(SQL.bumpMessageCount, [input.chatId, input.persona]);
  });

  // A caixa de entrada ouve isto e mostra a mensagem no instante em que ela
  // existe, sem esperar pelo ciclo de recarga nem por um F5.
  eventos.emitir('mensagem', {
    chatId: input.chatId,
    role: input.role,
    author: input.author ?? 'bot',
    content: input.content,
    mediaFileId: input.mediaFileId ?? null,
    createdAt: new Date().toISOString(),
    interna: ehNotaInterna({
      role: input.role,
      author: input.author ?? 'bot',
      mediaFileId: input.mediaFileId ?? null,
    }),
  });
}

/** Janela de memoria enviada as duas IAs, em ordem cronologica. */
export async function getRecentMessages(chatId: number,
  persona: IdPersona, limit = env.HISTORY_WINDOW): Promise<StoredMessage[]> {
  const rows = asRows<MessageRow>(await conn().all(SQL.recentMessages, [chatId, persona, limit]));
  return rows.map(mapMessage);
}

export interface InboxLead extends Lead {
  /** Ultima mensagem da conversa, para a pre-visualizacao na lista. */
  lastContent: string | null;
  lastRole: MessageRole | null;
  lastAt: string | null;
}

/**
 * Lista de conversas para a caixa de entrada, da mais recente para a mais
 * antiga. Ao contrario das listas de remarketing, nao esconde ninguem.
 */
export async function listInboxLeads(params: {
  /** A aba do painel: cada uma ve so as conversas do seu influencer. */
  persona: IdPersona;
  search?: string;
  stage?: string;
  limit?: number;
  offset?: number;
}): Promise<{ leads: InboxLead[]; total: number }> {
  const search = (params.search ?? '').trim().toLowerCase();
  const stage = (params.stage ?? '').trim();
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);

  type Row = LeadRow & {
    last_content: string | null;
    last_role: string | null;
    last_at: string | null;
    last_id: number | null;
  };

  const rows = asRows<Row>(
    await conn().all(SQL.inboxLeads, [params.persona, search, search, stage, stage, limit, offset]),
  );
  const count = asRow<{ total: number }>(
    await conn().get(SQL.countInboxLeads, [params.persona, search, search, stage, stage]),
  );

  return {
    leads: rows.map((row) => ({
      ...mapLead(row),
      lastContent: row.last_content,
      lastRole: row.last_role === null ? null : row.last_role === 'assistant' ? 'assistant' : 'user',
      lastAt: row.last_at,
    })),
    total: count?.total ?? 0,
  };
}

/**
 * Historico completo de um chat, em ordem cronologica.
 *
 * `before` e o id a partir do qual se pagina para tras; 0 significa "do fim".
 */
export async function getMessagesPage(
  chatId: number,
  persona: IdPersona,
  params: { before?: number; limit?: number } = {},
): Promise<StoredMessage[]> {
  const before = params.before ?? 0;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  return asRows<MessageRow>(await conn().all(SQL.messagesPage, [chatId, persona, before, before, limit])).map(
    mapMessage,
  );
}

/**
 * Liga ou desliga o controlo manual da conversa.
 *
 * Ligado, o funil grava o que o lead escreve mas nao responde: a conversa
 * passa a ser do operador ate ele a devolver ao bot.
 */
export async function setHumanHandover(chatId: number,
  persona: IdPersona, enabled: boolean): Promise<void> {
  await conn().run(SQL.setHandover, [enabled ? 1 : 0, chatId, persona]);
}

/** Apaga o historico do chat, mantendo o lead (usado pelo /reset). */
export async function clearHistory(chatId: number,
  persona: IdPersona): Promise<void> {
  await conn().run(SQL.deleteMessages, [chatId, persona]);
}

/** Remove lead e historico — usado pelo /parar, para respeitar o opt-out. */
export async function forgetLead(chatId: number,
  persona: IdPersona): Promise<void> {
  await inTransaction(async () => {
    await conn().run(SQL.deleteProofs, [chatId, persona]);
    await conn().run(SQL.deleteMessages, [chatId, persona]);
    await conn().run(SQL.deleteLead, [chatId, persona]);
  });
}

/**
 * Notas da propria aplicacao sobre si mesma.
 *
 * Servem para registar coisas que so podem acontecer UMA vez, como a limpeza
 * das conversas: sem uma marca guardada ao lado dos dados, uma operacao dessas
 * repetia-se a cada arranque e apagava tambem as conversas novas.
 */
export async function lerMeta(chave: string): Promise<string | null> {
  const row = asRow<{ valor: string }>(
    await conn().get('SELECT valor FROM app_meta WHERE chave = ?', [chave]),
  );

  return row?.valor ?? null;
}

/**
 * Apaga as conversas todas de uma vez, guardando os leads indicados.
 *
 * Quem decide SE isto corre e o modulo da limpeza; aqui so se executa, porque
 * e este o unico ficheiro que fala com a base de dados. As mensagens vao todas,
 * incluindo as dos leads guardados: o que se guarda e o lead, nao a conversa.
 *
 * Devolve o que foi apagado, para o arranque o poder dizer em voz alta. Uma
 * operacao destas nao pode acontecer em silencio.
 */
export async function apagarConversas(
  protegidos: number[],
): Promise<{ leadsApagados: number; mensagensApagadas: number; leadsMantidos: number }> {
  // Sao chat_id, ja validados como inteiros pelo env: nao ha texto de fora a
  // entrar no SQL. Uma lista literal evita uma tabela temporaria so para isto.
  const filtro =
    protegidos.length > 0
      ? ` WHERE chat_id NOT IN (${protegidos.map((id) => String(Math.trunc(id))).join(', ')})`
      : '';

  const antesLeads = Number(
    asRow<{ total: number }>(await conn().get('SELECT COUNT(*) AS total FROM leads'))?.total ?? 0,
  );
  const antesMensagens = Number(
    asRow<{ total: number }>(await conn().get('SELECT COUNT(*) AS total FROM messages'))?.total ?? 0,
  );

  await inTransaction(async (tx) => {
    await tx.run('DELETE FROM messages');
    await tx.run(`DELETE FROM deposit_proofs${filtro}`);
    await tx.run(`DELETE FROM leads${filtro}`);

    // O estado do remarketing deixa de fazer sentido: os leads a que dizia
    // respeito ja nao existem, e contadores de toques herdados calavam o bot
    // com quem chegasse a seguir.
    await tx.run('DELETE FROM remarketing_runs');
  });

  const mantidos = Number(
    asRow<{ total: number }>(await conn().get('SELECT COUNT(*) AS total FROM leads'))?.total ?? 0,
  );

  return {
    leadsApagados: antesLeads - mantidos,
    mensagensApagadas: antesMensagens,
    leadsMantidos: mantidos,
  };
}

export async function gravarMeta(chave: string, valor: string): Promise<void> {
  await conn().run(
    `INSERT INTO app_meta (chave, valor) VALUES (?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now')`,
    [chave, valor],
  );
}

/**
 * Reserva o envio de um slot para hoje. Devolve false se ja tinha sido
 * reservado: o Render reinicia o servico com frequencia, e sem esta marca na
 * base de dados cada reinicio dentro da janela reenviaria tudo outra vez.
 */
export async function claimRemarketingSlot(
  slot: string,
  runDate: string,
  audience: RemarketingAudience,
  persona: IdPersona,
): Promise<boolean> {
  const resultado = await conn().run(SQL.claimSlot, [slot, runDate, audience, persona]);
  return resultado.changes > 0;
}

export async function recordRemarketingSent(
  slot: string,
  runDate: string,
  audience: RemarketingAudience,
  sent: number,
  persona: IdPersona,
): Promise<void> {
  await conn().run(SQL.recordSlotSent, [sent, slot, runDate, audience, persona]);
}

/**
 * Leads a contactar. Fora ficam: quem bloqueou o bot, quem esta em 'perdido'
 * (inclui quem pediu para parar e quem mencionou divida ou vicio), quem ja
 * levou o numero maximo de lembretes, e quem falou connosco ha pouco — a esse
 * nao se manda um lembrete, responde-se.
 */
export async function getRemarketingTargets(params: {
  /** So os leads deste influencer: o guiao de um nao serve ao outro. */
  persona: IdPersona;
  audience: RemarketingAudience;
  /**
   * Quantos toques o lead ja levou. Para "nao_convertido" e uma igualdade
   * exacta, porque cada toque tem texto proprio. Ignorado no publico VIP.
   */
  touch?: number;
  /** Ha quanto tempo o lead tem de estar calado para entrar na lista. */
  coldHours: number;
  /** Intervalo minimo desde o ultimo toque. */
  sinceLastTouchHours: number;
  limit: number;
}): Promise<Lead[]> {
  const cold = `-${params.coldHours} hours`;
  const sinceLast = `-${params.sinceLastTouchHours} hours`;

  const rows =
    params.audience === 'link_parado'
      ? asRows<LeadRow>(await conn().all(SQL.targetsLinkParado, [params.persona, cold, params.limit]))
      : params.audience === 'vip'
      ? asRows<LeadRow>(await conn().all(SQL.targetsVip, [params.persona, sinceLast, params.limit]))
      : asRows<LeadRow>(
          await conn().all(SQL.targetsNotConverted, [params.persona, params.touch ?? 0, cold, sinceLast, params.limit]),
        );

  return rows.map(mapLead);
}

/**
 * O lead respondeu depois de ter levado um toque: sai da campanha.
 *
 * E a diferenca entre um funil e spam. Quem responde volta a ter uma conversa
 * a serio, e continuar a mandar-lhe guioes automaticos por cima disso e o que
 * faz a pessoa bloquear o bot.
 */
export async function cancelRemarketing(chatId: number,
  persona: IdPersona): Promise<void> {
  await conn().run(SQL.cancelRemarketing, [chatId, persona]);
}

export async function markRemarketed(chatId: number,
  persona: IdPersona): Promise<void> {
  await conn().run(SQL.markRemarketed, [chatId, persona]);
}

/** O lead bloqueou o bot: nunca mais lhe mandamos nada. */
export async function markBlocked(chatId: number,
  persona: IdPersona): Promise<void> {
  await conn().run(SQL.markBlocked, [chatId, persona]);
}

/**
 * Regista que o lead se comprometeu a tratar disto a uma certa hora. Uma
 * promessa nova substitui a anterior: vale a ultima coisa que ele disse.
 */
export async function setDepositPromise(chatId: number,
  persona: IdPersona, whenUtc: string, note: string | null): Promise<void> {
  await conn().run(SQL.setPromise, [whenUtc, note, chatId, persona]);
}

export async function clearDepositPromise(chatId: number,
  persona: IdPersona): Promise<void> {
  await conn().run(SQL.clearPromise, [chatId, persona]);
}

/**
 * Promessas vencidas. Quem ja depositou ou saiu do funil nao aparece — o
 * lembrete e para quem disse que ia tratar disto e ainda nao tratou.
 */
export async function getDuePromises(
  persona: IdPersona,
  nowUtc: string,
  limit: number,
): Promise<Lead[]> {
  return asRows<LeadRow>(await conn().all(SQL.duePromises, [persona, nowUtc, limit])).map(mapLead);
}

/**
 * Grava o cantao do lead. So escreve se ainda estiver vazio: a primeira
 * resposta e a boa, e uma mencao de passagem a outra cidade mais a frente
 * ("o meu primo esta em Genebra") nao pode mudar onde ele mora.
 */
/**
 * Marca o update como processado. Devolve true so a primeira vez.
 *
 * O INSERT e a propria verificacao: fazer SELECT e depois INSERT deixaria uma
 * fresta entre os dois por onde passa o reenvio que chega ao mesmo tempo.
 */
/**
 * Reserva este update, para nao ser entregue duas vezes.
 *
 * O `bot` faz parte da chave porque cada bot tem a SUA sequencia de update_id,
 * e as duas colidem. Sem ele, o update 5000 de um era descartado por o 5000 do
 * outro ja estar na tabela — e o lead ficava sem resposta, sem uma linha de log
 * a dizer porque.
 */
export async function claimUpdate(updateId: number, bot: IdPersona): Promise<boolean> {
  const result = await conn().run(SQL.claimUpdate, [updateId, bot]);
  return result.changes > 0;
}

/** Guarda so os ultimos updates: a tabela existe para dedup, nao para historia. */
export async function pruneProcessedUpdates(keep = 5000): Promise<void> {
  await conn().run(SQL.pruneUpdates, [keep]);
}

export async function setCanton(chatId: number,
  persona: IdPersona, canton: string): Promise<void> {
  await conn().run(SQL.setCanton, [canton, chatId, persona]);
}

/**
 * Repoe leads perdidos quando a base de dados foi apagada.
 *
 * Idempotente por construcao: um lead que ja exista nao e tocado, e a marca de
 * historico so entra em conversas vazias. Correr isto dez vezes da o mesmo
 * resultado que correr uma.
 *
 * O estagio so anda para a frente. Se o lead entretanto voltou a falar e ja
 * esta mais adiantado do que o que vem nos logs, o que esta na base de dados
 * ganha — os logs sao uma fotografia velha.
 */
export async function restoreLeads(
  leads: Array<{ chatId: number; stage: FunnelStage; firstName?: string | null }>,
): Promise<{ criados: number; existentes: number }> {
  let criados = 0;
  let existentes = 0;

  for (const lead of leads) {
    const existing = await getLead(lead.chatId, PERSONA_HISTORICA);

    if (existing) {
      existentes += 1;
    } else {
      criados += 1;
      await upsertLead({
        chatId: lead.chatId,
        persona: PERSONA_HISTORICA,
        firstName: lead.firstName ?? null,
      });
    }

    // advanceStage e nao setStage: nunca puxa um lead para tras.
    await advanceStage(lead.chatId, PERSONA_HISTORICA, lead.stage);

    if ((await getRecentMessages(lead.chatId, PERSONA_HISTORICA, 1)).length === 0) {
      await addMessage({
        chatId: lead.chatId,
        persona: PERSONA_HISTORICA,
        role: 'user',
        content:
          '[conversa recuperada: este lead ja falou contigo antes, mas o texto das mensagens ' +
          'perdeu-se. NAO te apresentes outra vez, NAO repitas a abertura e NAO recomeces o ' +
          'funil. Retoma como quem continua uma conversa: pergunta como ele esta e puxa pelo ' +
          'passo que falta no estagio em que ele esta]',
        author: 'sistema',
      });
    }
  }

  return { criados, existentes };
}

/**
 * Repoe os leads aprovados listados no VIP_CHAT_IDS.
 *
 * Enquanto a base de dados viver dentro da pasta da aplicacao, cada deploy
 * apaga tudo. Quem ja depositou e ja esta no grupo nao pode depender disso: a
 * seguir ao deploy o bot trata-o como desconhecido, recomeça o funil e pede o
 * registo a quem ja pagou. Isto corre no arranque e devolve-o ao estagio de
 * acesso liberado, afixado no topo da caixa.
 *
 * Nao substitui um disco persistente — o historico da conversa nao volta — e
 * por isso deixa uma marca no historico, para o estrategista saber com quem
 * esta a falar mesmo com a conversa vazia.
 *
 * E idempotente: correr isto num arranque onde a base de dados sobreviveu nao
 * mexe em nada a nao ser garantir o estagio e o afixado.
 */
export async function restoreVipLeads(
  leads: Array<{ chatId: number; firstName: string | null }>,
): Promise<number> {
  let restored = 0;

  for (const lead of leads) {
    const existing = await getLead(lead.chatId, PERSONA_HISTORICA);

    await upsertLead({
      chatId: lead.chatId,
      persona: PERSONA_HISTORICA,
      firstName: lead.firstName,
    });
    await setStage(lead.chatId, PERSONA_HISTORICA, 'acesso_liberado');
    await setPinned(lead.chatId, PERSONA_HISTORICA, true);

    // Conversa vazia: o lead foi criado agora, ou perdeu o historico no
    // deploy. A marca evita que o funil recomece do zero com quem ja pagou.
    if ((await getRecentMessages(lead.chatId, PERSONA_HISTORICA, 1)).length === 0) {
      await addMessage({
        chatId: lead.chatId,
        persona: PERSONA_HISTORICA,
        role: 'user',
        content:
          '[lead ja validado: depositou, foi aprovado a mao e ja esta dentro do grupo VIP. ' +
          'O historico anterior nao esta disponivel. NAO recomeces o funil nem peças registo ' +
          'ou deposito: o que se faz aqui e acompanhar como lhe esta a correr]',
        author: 'sistema',
      });
    }

    if (!existing) restored += 1;
  }

  return restored;
}

/**
 * Afixa ou desafixa o lead no topo da caixa de entrada.
 *
 * E so ordenacao: nao mexe no estagio, no remarketing nem no que o bot diz.
 */
export async function setPinned(chatId: number,
  persona: IdPersona, pinned: boolean): Promise<void> {
  await conn().run(SQL.setPinned, [pinned ? 1 : 0, chatId, persona]);
}

/**
 * Diz por onde e que esta conversa passa a entrar e sair.
 *
 * Escrito uma vez, quando o lead aparece pela primeira vez. Um lead que chegou
 * pelo bot nunca muda de canal sozinho: a conversa dele esta naquele chat, e
 * mudar o canal so faria as respostas saírem por um sitio onde ele nao esta.
 */
export async function setTransporte(
  chatId: number,
  persona: IdPersona,
  transporte: 'bot' | 'userbot' | 'bot_ivan',
): Promise<void> {
  await conn().run(SQL.setTransporte, [transporte, chatId, persona]);
}

/**
 * Poe o lead num estagio a mao.
 *
 * O advanceStage nunca anda para tras, de proposito: impede que o modelo
 * regrida um lead adiantado por ler mal uma mensagem. Mas quando sou eu a
 * dizer que o lead ja tem o acesso, o estagio tem de obedecer — o pagamento
 * foi validado por mim, fora do que o bot ve.
 */
export async function setStage(chatId: number,
  persona: IdPersona, stage: FunnelStage): Promise<void> {
  await conn().run(SQL.setStage, [stage, chatId, persona]);
}

/**
 * Guarda o nome e o username que o Telegram devolve.
 *
 * Os leads recuperados dos logs vinham so com o chat_id, e apareciam na caixa
 * de entrada como "#8962954467". Isto preenche-os a partir do getChat, e
 * tambem corrige quem tenha mudado de nome ou de username entretanto.
 */
export async function setIdentity(
  chatId: number,
  persona: IdPersona,
  identity: { firstName: string | null; lastName: string | null; username: string | null },
): Promise<void> {
  await conn().run(SQL.setIdentity, [identity.firstName,
    identity.lastName,
    identity.username,
    chatId,
    persona,]);
}

/** Leads sem nome nenhum: sao estes que aparecem como "#id" na caixa. */
export async function leadsSemNome(persona: IdPersona, limit = 200): Promise<number[]> {
  const rows = asRows<{ chat_id: number }>(
    await conn().all(SQL.leadsWithoutName, [persona, Math.max(1, Math.min(limit, 1000))]),
  );
  return rows.map((row) => row.chat_id);
}

/** A primeira resposta e a boa: escritas seguintes sao ignoradas no SQL. */
export async function setJob(chatId: number,
  persona: IdPersona, job: string): Promise<void> {
  await conn().run(SQL.setJob, [job, chatId, persona]);
}

/** A primeira resposta e a boa: escritas seguintes sao ignoradas no SQL. */
export async function setBettingExperience(chatId: number,
  persona: IdPersona, experience: string): Promise<void> {
  await conn().run(SQL.setBettingExperience, [experience, chatId, persona]);
}

/** Como se trata o lead. A primeira vez que se souber e a que fica. */
export async function setTratamento(chatId: number,
  persona: IdPersona, nome: string): Promise<void> {
  await conn().run(SQL.setTratamento, [nome.slice(0, 40), chatId, persona]);
}

/**
 * Marca uma pergunta como FEITA, tenha ela tido resposta util ou nao.
 *
 * E o que garante que cada pergunta sai uma vez so. O campo do facto guarda a
 * RESPOSTA; este guarda que a pergunta chegou a ser feita — e sao coisas
 * diferentes quando o lead responde "nao trabalho".
 */
export async function marcarPerguntaFeita(chatId: number,
  persona: IdPersona, chave: string): Promise<void> {
  await conn().run(SQL.marcarPergunta, [chave, chave, chave, chatId, persona]);
}

/** Marca que o nome ja foi perguntado, mesmo que ele nao responda. */
export async function setNomePerguntado(chatId: number,
  persona: IdPersona): Promise<void> {
  await conn().run(SQL.setNomePerguntado, [chatId, persona]);
}

/** O que o trouxe aqui. */
export async function setAtencao(chatId: number,
  persona: IdPersona, atencao: string): Promise<void> {
  await conn().run(SQL.setAtencao, [atencao.slice(0, 200), chatId, persona]);
}

/** Ha quanto tempo vive na Suica. */
export async function setTempoSuica(chatId: number,
  persona: IdPersona, tempo: string): Promise<void> {
  await conn().run(SQL.setTempoSuica, [tempo.slice(0, 60), chatId, persona]);
}

/**
 * Em que o Pedrito diz ter trabalhado, com ESTE lead.
 *
 * Escolhido uma vez e guardado: sem isto, o modelo dizia "obras" num turno e
 * "restauracao" tres turnos depois, ao mesmo lead. Uma pessoa nao muda de
 * passado a meio da conversa.
 */
export async function setOficioPedrito(chatId: number,
  persona: IdPersona, oficio: string): Promise<void> {
  await conn().run(SQL.setOficioPedrito, [oficio, chatId, persona]);
}

/**
 * Marca o lead como qualificado (ja depositou) ou nao.
 *
 * Posta pelos comandos /aprovado e /naoaprovado, e e ela que decide qual das
 * campanhas de remarketing lhe toca.
 */
export async function setTag(chatId: number,
  persona: IdPersona, tag: string | null): Promise<void> {
  await conn().run(SQL.setTag, [tag, chatId, persona]);
}

export async function getStats(persona: IdPersona): Promise<FunnelStats> {
  const leads = asRow<{ total: number }>(await conn().get(SQL.countLeads, [persona]));
  const messages = asRow<{ total: number }>(await conn().get(SQL.countMessages, [persona]));
  const stages = asRows<{ stage: string; total: number }>(await conn().all(SQL.countByStage, [persona]));
  const proofs = asRow<{ total: number }>(await conn().get(SQL.countPendingProofs, [persona]));
  const promises = asRow<{ total: number }>(await conn().get(SQL.countPromises, [persona]));

  const byStage: Record<string, number> = {};
  for (const row of stages) {
    byStage[row.stage] = row.total;
  }

  return {
    totalLeads: leads?.total ?? 0,
    totalMessages: messages?.total ?? 0,
    byStage,
    pendingProofs: proofs?.total ?? 0,
    pendingPromises: promises?.total ?? 0,
  };
}

/**
 * Forca o WAL para dentro do ficheiro principal.
 *
 * O backup copia o .sqlite sozinho; sem isto as ultimas escritas ficavam no
 * -wal e o backup saia incompleto sem dar erro nenhum.
 */
export async function checkpointDatabase(): Promise<void> {
  // So faz sentido no SQLite: e o WAL dele que fica num ficheiro a parte.
  if (!driver || driver.dialect !== 'sqlite') return;

  try {
    await driver.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    log.warn('falha no checkpoint do WAL antes do backup', error);
  }
}

export async function closeDatabase(): Promise<void> {
  if (!driver) return;

  try {
    await driver.close();
    log.info('Ligacao a base de dados encerrada');
  } catch (error) {
    log.warn('Falha ao encerrar a base de dados', error);
  }
}

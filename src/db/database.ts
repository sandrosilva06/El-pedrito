import fs from 'node:fs';
import path from 'node:path';

import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { ehNotaInterna, eventos } from '../utils/eventos';
import { openDriver, type Driver } from './driver';

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
const DDL: Record<'sqlite' | 'postgres', string[]> = {
  sqlite: [
    `CREATE TABLE IF NOT EXISTS leads (
      chat_id       INTEGER PRIMARY KEY,
      first_name    TEXT,
      username      TEXT,
      language_code TEXT,
      stage         TEXT NOT NULL DEFAULT 'novo',
      notes         TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    INTEGER NOT NULL REFERENCES leads(chat_id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      directive  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS deposit_proofs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     INTEGER NOT NULL REFERENCES leads(chat_id) ON DELETE CASCADE,
      lead_name   TEXT,
      username    TEXT,
      file_id     TEXT NOT NULL,
      message_id  INTEGER,
      status      TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'aprovado', 'recusado')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS processed_updates (
      update_id  INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS remarketing_runs (
      slot       TEXT NOT NULL,
      run_date   TEXT NOT NULL,
      audience   TEXT NOT NULL,
      sent       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (slot, run_date, audience)
    )`,
  ],
  postgres: [
    `CREATE TABLE IF NOT EXISTS leads (
      chat_id       BIGINT PRIMARY KEY,
      first_name    TEXT,
      username      TEXT,
      language_code TEXT,
      stage         TEXT NOT NULL DEFAULT 'novo',
      notes         TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id         BIGSERIAL PRIMARY KEY,
      chat_id    BIGINT NOT NULL REFERENCES leads(chat_id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      directive  TEXT,
      created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS deposit_proofs (
      id          BIGSERIAL PRIMARY KEY,
      chat_id     BIGINT NOT NULL REFERENCES leads(chat_id) ON DELETE CASCADE,
      lead_name   TEXT,
      username    TEXT,
      file_id     TEXT NOT NULL,
      message_id  BIGINT,
      status      TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'aprovado', 'recusado')),
      created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS processed_updates (
      update_id  BIGINT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    )`,
    `CREATE TABLE IF NOT EXISTS remarketing_runs (
      slot       TEXT NOT NULL,
      run_date   TEXT NOT NULL,
      audience   TEXT NOT NULL,
      sent       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (slot, run_date, audience)
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
    promisedAt: row.promised_at,
    promiseNote: row.promise_note,
    canton: row.canton,
    lastName: row.last_name,
    pinned: row.pinned === 1,
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
  upsertLead: `
    INSERT INTO leads (chat_id, first_name, username, language_code)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      first_name    = COALESCE(excluded.first_name, leads.first_name),
      username      = COALESCE(excluded.username, leads.username),
      language_code = COALESCE(excluded.language_code, leads.language_code),
      updated_at    = datetime('now')
  `,
  getLead: 'SELECT * FROM leads WHERE chat_id = ?',
  updateStage: `
    UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE chat_id = ?
  `,
  updateNotes: `
    UPDATE leads SET notes = ?, updated_at = datetime('now') WHERE chat_id = ?
  `,
  bumpMessageCount: `
    UPDATE leads
       SET message_count = message_count + 1,
           updated_at    = datetime('now')
     WHERE chat_id = ?
  `,
  insertMessage: `
    INSERT INTO messages (chat_id, role, author, content, media_file_id, media_kind, directive)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
           (SELECT content    FROM messages m WHERE m.chat_id = l.chat_id AND NOT (m.role = 'user' AND m.author = 'sistema' AND m.media_file_id IS NULL) ORDER BY m.id DESC LIMIT 1) AS last_content,
           (SELECT role       FROM messages m WHERE m.chat_id = l.chat_id AND NOT (m.role = 'user' AND m.author = 'sistema' AND m.media_file_id IS NULL) ORDER BY m.id DESC LIMIT 1) AS last_role,
           (SELECT created_at FROM messages m WHERE m.chat_id = l.chat_id AND NOT (m.role = 'user' AND m.author = 'sistema' AND m.media_file_id IS NULL) ORDER BY m.id DESC LIMIT 1) AS last_at,
           (SELECT id         FROM messages m WHERE m.chat_id = l.chat_id ORDER BY m.id DESC LIMIT 1) AS last_id
      FROM leads l
     WHERE (? = '' OR lower(coalesce(l.first_name, '') || ' ' || coalesce(l.username, '')) LIKE '%' || ? || '%')
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
     WHERE (? = '' OR lower(coalesce(l.first_name, '') || ' ' || coalesce(l.username, '')) LIKE '%' || ? || '%')
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
       WHERE chat_id = ? AND (? = 0 OR id < ?)
       ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `,
  setHandover: `
    UPDATE leads SET human_handover = ?, updated_at = datetime('now') WHERE chat_id = ?
  `,
  recentMessages: `
    SELECT * FROM (
      SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `,
  deleteMessages: 'DELETE FROM messages WHERE chat_id = ?',
  deleteLead: 'DELETE FROM leads WHERE chat_id = ?',
  countLeads: 'SELECT COUNT(*) AS total FROM leads',
  countMessages: 'SELECT COUNT(*) AS total FROM messages',
  countByStage: 'SELECT stage, COUNT(*) AS total FROM leads GROUP BY stage',
  insertProof: `
    INSERT INTO deposit_proofs (chat_id, lead_name, username, file_id, message_id)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `,
  countPendingProofs: "SELECT COUNT(*) AS total FROM deposit_proofs WHERE status = 'pendente'",
  deleteProofs: 'DELETE FROM deposit_proofs WHERE chat_id = ?',
  claimSlot: `
    INSERT INTO remarketing_runs (slot, run_date, audience) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `,
  recordSlotSent: `
    UPDATE remarketing_runs SET sent = ? WHERE slot = ? AND run_date = ? AND audience = ?
  `,
  markRemarketed: `
    UPDATE leads
       SET last_remarketing_at = datetime('now'),
           remarketing_touches = remarketing_touches + 1
     WHERE chat_id = ?
  `,
  markBlocked: "UPDATE leads SET blocked = 1 WHERE chat_id = ?",
  cancelRemarketing: `
    UPDATE leads
       SET remarketing_cancelled = 1
     WHERE chat_id = ?
       -- So conta como resposta AO remarketing. Quem escreve antes de ter
       -- levado algum toque esta so a conversar, e continua elegivel se
       -- depois arrefecer.
       AND last_remarketing_at IS NOT NULL
       AND remarketing_cancelled = 0
  `,
  claimUpdate: 'INSERT INTO processed_updates (update_id) VALUES (?) ON CONFLICT DO NOTHING',
  pruneUpdates: `
    DELETE FROM processed_updates
     WHERE update_id NOT IN (
       SELECT update_id FROM processed_updates ORDER BY update_id DESC LIMIT ?
     )
  `,
  setCanton: `
    UPDATE leads SET canton = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND (canton IS NULL OR canton = '')
  `,
  setPinned: 'UPDATE leads SET pinned = ? WHERE chat_id = ?',
  setIdentity: `
    UPDATE leads
       SET first_name = coalesce(?, first_name),
           last_name = coalesce(?, last_name),
           username = coalesce(?, username)
     WHERE chat_id = ?
  `,
  leadsWithoutName: `
    SELECT chat_id FROM leads
     WHERE (first_name IS NULL OR first_name = '')
       AND blocked = 0
     ORDER BY updated_at DESC
     LIMIT ?
  `,
  setStage: "UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE chat_id = ?",
  setJob: `
    UPDATE leads SET job = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND (job IS NULL OR job = '')
  `,
  setBettingExperience: `
    UPDATE leads SET betting_experience = ?, updated_at = datetime('now')
     WHERE chat_id = ? AND (betting_experience IS NULL OR betting_experience = '')
  `,
  setPromise: `
    UPDATE leads SET promised_at = ?, promise_note = ?, updated_at = datetime('now')
     WHERE chat_id = ?
  `,
  clearPromise: 'UPDATE leads SET promised_at = NULL, promise_note = NULL WHERE chat_id = ?',
  duePromises: `
    SELECT * FROM leads
     WHERE blocked = 0
       AND promised_at IS NOT NULL
       AND promised_at <= ?
       AND stage NOT IN ('perdido', ${CONVERTED_STAGES.map((stage) => `'${stage}'`).join(', ')})
     ORDER BY promised_at ASC
     LIMIT ?
  `,
  countPromises: 'SELECT COUNT(*) AS total FROM leads WHERE promised_at IS NOT NULL',
  /**
   * Lead que recebeu o link e ficou calado.
   *
   * E o balde mais quente do funil e o que mais se perde: ele ja disse que sim,
   * ja tem a pagina, e travou em alguma coisa. Esperar as 24h do toque normal e
   * chegar tarde. Por isso tem lista propria, com janela propria.
   */
  targetsLinkParado: `
    SELECT * FROM leads
     WHERE blocked = 0
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
     WHERE blocked = 0
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
     WHERE blocked = 0
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
  leadName: string | null;
  username: string | null;
  fileId: string;
  messageId: number | null;
}): Promise<DepositProof> {
  // RETURNING em vez do lastInsertRowid: e a unica forma que funciona nos dois
  // motores, e o SQLite suporta-a desde a 3.35.
  const criado = await conn().get<{ id: number }>(SQL.insertProof, [
    input.chatId,
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
  firstName?: string | null;
  username?: string | null;
  languageCode?: string | null;
}): Promise<Lead> {
  // Saber se ja existia ANTES de escrever: e o que distingue um lead novo, que
  // tem de aparecer na caixa de entrada na hora, de uma actualizacao de quem
  // ja la esta.
  const existia = asRow<LeadRow>(await conn().get(SQL.getLead, [input.chatId])) !== undefined;

  await conn().run(SQL.upsertLead, [input.chatId,
    input.firstName ?? null,
    input.username ?? null,
    input.languageCode ?? null,]);

  const row = asRow<LeadRow>(await conn().get(SQL.getLead, [input.chatId]));

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

export async function getLead(chatId: number): Promise<Lead | null> {
  const row = asRow<LeadRow>(await conn().get(SQL.getLead, [chatId]));
  return row ? mapLead(row) : null;
}

/**
 * Avanca o estagio do lead. Retrocessos sao ignorados — a unica excecao e
 * `perdido`, que pode ser marcado a qualquer momento (opt-out do lead).
 */
export async function advanceStage(chatId: number, next: FunnelStage): Promise<FunnelStage> {
  const lead = await getLead(chatId);
  const current = lead?.stage ?? 'novo';

  if (next === current) return current;

  if (next !== 'perdido' && current !== 'perdido') {
    const currentIndex = STAGE_ORDER.get(current) ?? 0;
    const nextIndex = STAGE_ORDER.get(next) ?? 0;
    if (nextIndex < currentIndex) return current;
  }

  await conn().run(SQL.updateStage, [next, chatId]);
  return next;
}

export async function setNotes(chatId: number, notes: string | null): Promise<void> {
  await conn().run(SQL.updateNotes, [notes, chatId]);
}

export async function addMessage(input: {
  chatId: number;
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
      input.role,
      input.author ?? 'bot',
      input.content,
      input.mediaFileId ?? null,
      input.mediaKind ?? (input.mediaFileId ? 'photo' : null),
      input.directive ?? null,]);
    await conn().run(SQL.bumpMessageCount, [input.chatId]);
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
export async function getRecentMessages(chatId: number, limit = env.HISTORY_WINDOW): Promise<StoredMessage[]> {
  const rows = asRows<MessageRow>(await conn().all(SQL.recentMessages, [chatId, limit]));
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
    await conn().all(SQL.inboxLeads, [search, search, stage, stage, limit, offset]),
  );
  const count = asRow<{ total: number }>(
    await conn().get(SQL.countInboxLeads, [search, search, stage, stage]),
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
  params: { before?: number; limit?: number } = {},
): Promise<StoredMessage[]> {
  const before = params.before ?? 0;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  return asRows<MessageRow>(await conn().all(SQL.messagesPage, [chatId, before, before, limit])).map(
    mapMessage,
  );
}

/**
 * Liga ou desliga o controlo manual da conversa.
 *
 * Ligado, o funil grava o que o lead escreve mas nao responde: a conversa
 * passa a ser do operador ate ele a devolver ao bot.
 */
export async function setHumanHandover(chatId: number, enabled: boolean): Promise<void> {
  await conn().run(SQL.setHandover, [enabled ? 1 : 0, chatId]);
}

/** Apaga o historico do chat, mantendo o lead (usado pelo /reset). */
export async function clearHistory(chatId: number): Promise<void> {
  await conn().run(SQL.deleteMessages, [chatId]);
}

/** Remove lead e historico — usado pelo /parar, para respeitar o opt-out. */
export async function forgetLead(chatId: number): Promise<void> {
  await inTransaction(async () => {
    await conn().run(SQL.deleteProofs, [chatId]);
    await conn().run(SQL.deleteMessages, [chatId]);
    await conn().run(SQL.deleteLead, [chatId]);
  });
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
): Promise<boolean> {
  const resultado = await conn().run(SQL.claimSlot, [slot, runDate, audience]);
  return resultado.changes > 0;
}

export async function recordRemarketingSent(
  slot: string,
  runDate: string,
  audience: RemarketingAudience,
  sent: number,
): Promise<void> {
  await conn().run(SQL.recordSlotSent, [sent, slot, runDate, audience]);
}

/**
 * Leads a contactar. Fora ficam: quem bloqueou o bot, quem esta em 'perdido'
 * (inclui quem pediu para parar e quem mencionou divida ou vicio), quem ja
 * levou o numero maximo de lembretes, e quem falou connosco ha pouco — a esse
 * nao se manda um lembrete, responde-se.
 */
export async function getRemarketingTargets(params: {
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
      ? asRows<LeadRow>(await conn().all(SQL.targetsLinkParado, [cold, params.limit]))
      : params.audience === 'vip'
      ? asRows<LeadRow>(await conn().all(SQL.targetsVip, [sinceLast, params.limit]))
      : asRows<LeadRow>(
          await conn().all(SQL.targetsNotConverted, [params.touch ?? 0, cold, sinceLast, params.limit]),
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
export async function cancelRemarketing(chatId: number): Promise<void> {
  await conn().run(SQL.cancelRemarketing, [chatId]);
}

export async function markRemarketed(chatId: number): Promise<void> {
  await conn().run(SQL.markRemarketed, [chatId]);
}

/** O lead bloqueou o bot: nunca mais lhe mandamos nada. */
export async function markBlocked(chatId: number): Promise<void> {
  await conn().run(SQL.markBlocked, [chatId]);
}

/**
 * Regista que o lead se comprometeu a tratar disto a uma certa hora. Uma
 * promessa nova substitui a anterior: vale a ultima coisa que ele disse.
 */
export async function setDepositPromise(chatId: number, whenUtc: string, note: string | null): Promise<void> {
  await conn().run(SQL.setPromise, [whenUtc, note, chatId]);
}

export async function clearDepositPromise(chatId: number): Promise<void> {
  await conn().run(SQL.clearPromise, [chatId]);
}

/**
 * Promessas vencidas. Quem ja depositou ou saiu do funil nao aparece — o
 * lembrete e para quem disse que ia tratar disto e ainda nao tratou.
 */
export async function getDuePromises(nowUtc: string, limit: number): Promise<Lead[]> {
  return asRows<LeadRow>(await conn().all(SQL.duePromises, [nowUtc, limit])).map(mapLead);
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
export async function claimUpdate(updateId: number): Promise<boolean> {
  const result = await conn().run(SQL.claimUpdate, [updateId]);
  return result.changes > 0;
}

/** Guarda so os ultimos updates: a tabela existe para dedup, nao para historia. */
export async function pruneProcessedUpdates(keep = 5000): Promise<void> {
  await conn().run(SQL.pruneUpdates, [keep]);
}

export async function setCanton(chatId: number, canton: string): Promise<void> {
  await conn().run(SQL.setCanton, [canton, chatId]);
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
    const existing = await getLead(lead.chatId);

    if (existing) {
      existentes += 1;
    } else {
      criados += 1;
      await upsertLead({ chatId: lead.chatId, firstName: lead.firstName ?? null });
    }

    // advanceStage e nao setStage: nunca puxa um lead para tras.
    await advanceStage(lead.chatId, lead.stage);

    if ((await getRecentMessages(lead.chatId, 1)).length === 0) {
      await addMessage({
        chatId: lead.chatId,
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
    const existing = await getLead(lead.chatId);

    await upsertLead({ chatId: lead.chatId, firstName: lead.firstName });
    await setStage(lead.chatId, 'acesso_liberado');
    await setPinned(lead.chatId, true);

    // Conversa vazia: o lead foi criado agora, ou perdeu o historico no
    // deploy. A marca evita que o funil recomece do zero com quem ja pagou.
    if ((await getRecentMessages(lead.chatId, 1)).length === 0) {
      await addMessage({
        chatId: lead.chatId,
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
export async function setPinned(chatId: number, pinned: boolean): Promise<void> {
  await conn().run(SQL.setPinned, [pinned ? 1 : 0, chatId]);
}

/**
 * Poe o lead num estagio a mao.
 *
 * O advanceStage nunca anda para tras, de proposito: impede que o modelo
 * regrida um lead adiantado por ler mal uma mensagem. Mas quando sou eu a
 * dizer que o lead ja tem o acesso, o estagio tem de obedecer — o pagamento
 * foi validado por mim, fora do que o bot ve.
 */
export async function setStage(chatId: number, stage: FunnelStage): Promise<void> {
  await conn().run(SQL.setStage, [stage, chatId]);
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
  identity: { firstName: string | null; lastName: string | null; username: string | null },
): Promise<void> {
  await conn().run(SQL.setIdentity, [identity.firstName,
    identity.lastName,
    identity.username,
    chatId,]);
}

/** Leads sem nome nenhum: sao estes que aparecem como "#id" na caixa. */
export async function leadsSemNome(limit = 200): Promise<number[]> {
  const rows = asRows<{ chat_id: number }>(
    await conn().all(SQL.leadsWithoutName, [Math.max(1, Math.min(limit, 1000))]),
  );
  return rows.map((row) => row.chat_id);
}

/** A primeira resposta e a boa: escritas seguintes sao ignoradas no SQL. */
export async function setJob(chatId: number, job: string): Promise<void> {
  await conn().run(SQL.setJob, [job, chatId]);
}

/** A primeira resposta e a boa: escritas seguintes sao ignoradas no SQL. */
export async function setBettingExperience(chatId: number, experience: string): Promise<void> {
  await conn().run(SQL.setBettingExperience, [experience, chatId]);
}

export async function getStats(): Promise<FunnelStats> {
  const leads = asRow<{ total: number }>(await conn().get(SQL.countLeads, []));
  const messages = asRow<{ total: number }>(await conn().get(SQL.countMessages, []));
  const stages = asRows<{ stage: string; total: number }>(await conn().all(SQL.countByStage, []));
  const proofs = asRow<{ total: number }>(await conn().get(SQL.countPendingProofs, []));
  const promises = asRow<{ total: number }>(await conn().get(SQL.countPromises, []));

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

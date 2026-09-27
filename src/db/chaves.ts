/**
 * As chaves que tem de crescer para caber duas personas no mesmo servico.
 *
 * Tres tabelas foram desenhadas quando havia um influencer so, e as tres
 * partem em silencio quando ha dois. Nenhuma delas da erro: limitam-se a comer
 * leads, que e a pior forma de uma coisa estar mal.
 *
 * 1. leads.chat_id era a chave primaria. O chat_id e o id da PESSOA no
 *    Telegram, e a mesma pessoa pode escrever aos dois bots — um emigrante que
 *    veja os dois anuncios e um caso normal, nao uma hipotese remota. Com uma
 *    linha so por pessoa, o segundo bot responderia com a persona do primeiro:
 *    exactamente a mistura que nao pode acontecer.
 *
 * 2. processed_updates.update_id era a chave. Serve para nao entregar o mesmo
 *    update duas vezes. Cada bot tem a SUA sequencia de update_id, e as duas
 *    colidem: o update 5000 do Ivan era descartado por o 5000 do El Pedrito ja
 *    la estar. Um lead perdido, sem uma linha de log.
 *
 * 3. remarketing_runs tinha chave (slot, run_date, audience), que reserva o
 *    disparo do dia. Sem a persona, o disparo das 09:30 de um marcava o slot
 *    como feito e o do outro nunca saia. Para sempre, e em silencio.
 *
 * Isto corre no arranque e e decidido por INSPECCAO e nao por um sinal
 * guardado: pergunta-se a base de dados como e que a chave esta, e mexe-se so
 * se faltar. Um sinal em app_meta podia estar posto com a migracao a meio —
 * inspeccionar nao tem esse problema, e faz de conta que nada aconteceu quando
 * a base de dados ja nasceu certa.
 */
import type { Driver } from './driver';
import { createLogger } from '../utils/logger';

const log = createLogger('chaves');

/** A persona por omissao: quem ja esta na base de dados e do El Pedrito. */
const PERSONA_ANTIGA = 'el_pedrito';

/** O bot por omissao em processed_updates: o que ja existia. */
const BOT_ANTIGO = 'el_pedrito';

interface ColunaSqlite {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** As colunas que fazem parte da chave primaria desta tabela, por ordem. */
async function chavePrimaria(d: Driver, tabela: string): Promise<string[]> {
  if (d.dialect === 'sqlite') {
    const colunas = await d.all<ColunaSqlite>(`PRAGMA table_info(${tabela})`);
    return colunas
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
  }

  const linhas = await d.all<{ attname: string }>(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ?::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [tabela],
  );

  return linhas.map((l) => l.attname);
}

/**
 * O DEFAULT como o SQLite o aceita de volta.
 *
 * O PRAGMA devolve a expressao SEM os parenteses com que foi escrita — um
 * `DEFAULT (datetime('now'))` volta como `datetime('now')` — e sem eles o
 * SQLite recusa o CREATE TABLE com "near (: syntax error". Literais passam
 * como estao; qualquer expressao leva os parenteses de volta.
 */
function defeitoValido(valor: string): string {
  const texto = valor.trim();

  const ehLiteral =
    /^-?\d+(\.\d+)?$/.test(texto) ||
    /^'([^']|'')*'$/.test(texto) ||
    /^(NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(texto);

  if (ehLiteral || texto.startsWith('(')) return texto;

  return `(${texto})`;
}

/**
 * Reconstroi uma tabela do SQLite com uma chave primaria nova.
 *
 * O SQLite nao sabe alterar uma chave primaria: o caminho oficial e criar a
 * tabela nova, copiar, apagar a velha e mudar o nome. As colunas sao lidas da
 * tabela que esta la em vez de escritas a mao aqui, senao acrescentar uma
 * coluna noutro sitio deixava esta lista desactualizada sem ninguem dar por
 * isso — e a copia perdia essa coluna.
 */
async function reconstruirSqlite(
  d: Driver,
  tabela: string,
  chaveNova: string[],
): Promise<void> {
  const colunas = await d.all<ColunaSqlite>(`PRAGMA table_info(${tabela})`);

  const definicoes = colunas.map((c) => {
    // A chave primaria sai da definicao da coluna e passa a ser declarada a
    // parte, no fim: uma chave composta nao cabe ao lado de uma coluna.
    const partes = [c.name, c.type];
    if (c.notnull) partes.push('NOT NULL');
    if (c.dflt_value !== null) partes.push(`DEFAULT ${defeitoValido(c.dflt_value)}`);
    return `      ${partes.join(' ')}`;
  });

  const nomes = colunas.map((c) => c.name).join(', ');

  await d.exec(
    `CREATE TABLE ${tabela}_novo (\n${definicoes.join(',\n')},\n` +
      `      PRIMARY KEY (${chaveNova.join(', ')})\n    )`,
  );
  await d.exec(`INSERT INTO ${tabela}_novo (${nomes}) SELECT ${nomes} FROM ${tabela}`);
  await d.exec(`DROP TABLE ${tabela}`);
  await d.exec(`ALTER TABLE ${tabela}_novo RENAME TO ${tabela}`);
}

/** Troca a chave primaria de uma tabela do Postgres. */
async function trocarChavePostgres(
  d: Driver,
  tabela: string,
  chaveNova: string[],
): Promise<void> {
  const atual = await d.get<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = ?::regclass AND contype = 'p'`,
    [tabela],
  );

  if (atual) {
    await d.exec(`ALTER TABLE ${tabela} DROP CONSTRAINT "${atual.conname}" CASCADE`);
  }

  await d.exec(`ALTER TABLE ${tabela} ADD PRIMARY KEY (${chaveNova.join(', ')})`);
}

/** Muda a chave de uma tabela, seja qual for o motor. */
async function porChave(d: Driver, tabela: string, chaveNova: string[]): Promise<void> {
  const atual = await chavePrimaria(d, tabela);

  // Ja esta feita? Entao nao se toca. E o que faz isto ser seguro correr a
  // cada arranque.
  if (chaveNova.every((coluna) => atual.includes(coluna))) return;

  log.warn(`${tabela}: chave (${atual.join(', ')}) -> (${chaveNova.join(', ')})`);

  if (d.dialect === 'sqlite') await reconstruirSqlite(d, tabela, chaveNova);
  else await trocarChavePostgres(d, tabela, chaveNova);

  log.info(`${tabela}: chave nova no lugar`);
}

/**
 * Poe as tres chaves em dia.
 *
 * Corre DEPOIS de as colunas novas existirem (persona, bot), porque uma chave
 * nao pode apontar para uma coluna que ainda nao esta la.
 *
 * As chaves estrangeiras de messages e deposit_proofs para leads(chat_id) caem
 * com o CASCADE no Postgres e ficam inertes no SQLite, que nao as verifica. Nao
 * se voltam a criar de proposito: uma chave estrangeira composta obrigava a
 * persona a estar preenchida nas duas pontas antes de qualquer escrita, e um
 * lead que chegue primeiro que a sua mensagem passava a rebentar. A integridade
 * aqui e garantida pelo codigo, que nunca grava uma mensagem sem o lead.
 */
export async function migrarChaves(d: Driver): Promise<void> {
  await porChave(d, 'leads', ['chat_id', 'persona']);
  await porChave(d, 'processed_updates', ['update_id', 'bot']);
  await porChave(d, 'remarketing_runs', ['slot', 'run_date', 'audience', 'persona']);
}

export { PERSONA_ANTIGA, BOT_ANTIGO };

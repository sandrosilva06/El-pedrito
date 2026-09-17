/**
 * Move os dados do SQLite para o Postgres.
 *
 * Correr UMA vez, com o servico parado, depois de ter o DATABASE_URL a
 * apontar para a base nova:
 *
 *   DATABASE_URL=postgresql://... npx tsx src/scripts/migrar-para-postgres.ts
 *
 * Le o ficheiro SQLite indicado pelo DATABASE_PATH (ou o de sempre) e escreve
 * tudo no Postgres, tabela a tabela, pela ordem das dependencias: os leads
 * primeiro, porque as mensagens e os comprovativos apontam para eles.
 *
 * E IDEMPOTENTE. Cada insercao leva ON CONFLICT DO NOTHING, portanto correr
 * duas vezes nao duplica nada — e se a primeira passagem morrer a meio, basta
 * voltar a correr. Numa migracao de dados a serio, poder repetir sem medo vale
 * mais do que ser rapido.
 *
 * NAO APAGA o SQLite. Enquanto o ficheiro existir ha por onde voltar atras:
 * tira-se o DATABASE_URL e o servico volta ao que era.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { env } from '../config/env';
import { initDatabase, databaseDialect } from '../db/database';
import { openDriver, type Driver } from '../db/driver';
import { createLogger } from '../utils/logger';

const log = createLogger('migracao');

/** Le uma tabela inteira do SQLite. */
function lerTudo(db: DatabaseSync, tabela: string): Array<Record<string, unknown>> {
  try {
    return db.prepare(`SELECT * FROM ${tabela}`).all() as Array<Record<string, unknown>>;
  } catch {
    // A tabela pode nao existir num ficheiro antigo. Nao e erro: e uma base
    // de dados de uma versao anterior, e o que la nao esta nao se migra.
    log.warn(`tabela ${tabela} nao existe no SQLite; ignorada`);
    return [];
  }
}

/**
 * Copia as linhas, uma a uma.
 *
 * Uma a uma e nao em lote de proposito: sao poucos milhares de linhas, e assim
 * uma linha estragada (um campo que o Postgres recusa) nao leva o lote inteiro
 * atras dela — falha so ela, fica registada, e a migracao continua.
 */
async function copiar(
  destino: Driver,
  tabela: string,
  linhas: Array<Record<string, unknown>>,
  conflito: string,
): Promise<{ copiadas: number; falhadas: number }> {
  if (linhas.length === 0) return { copiadas: 0, falhadas: 0 };

  const colunas = Object.keys(linhas[0]!);
  const marcadores = colunas.map(() => '?').join(', ');
  const sql = `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${marcadores}) ${conflito}`;

  let copiadas = 0;
  let falhadas = 0;

  for (const linha of linhas) {
    try {
      await destino.run(sql, colunas.map((c) => linha[c] ?? null));
      copiadas += 1;
    } catch (error) {
      falhadas += 1;
      log.error(`${tabela}: linha recusada`, error);
    }
  }

  return { copiadas, falhadas };
}

async function main(): Promise<void> {
  if (!env.DATABASE_URL) {
    log.error('sem DATABASE_URL: nao ha para onde migrar. Define-a e volta a correr.');
    process.exit(1);
  }

  const ficheiro = env.databaseFile;

  if (ficheiro === ':memory:' || !existsSync(ficheiro)) {
    log.error(`nao ha SQLite em ${ficheiro} para migrar.`);
    process.exit(1);
  }

  log.info(`origem: ${ficheiro}`);

  // O destino abre pelo caminho normal, o que garante que o esquema fica
  // criado e actualizado antes de se escrever a primeira linha.
  await initDatabase();

  if (databaseDialect() !== 'postgres') {
    log.error('o destino nao e Postgres. Verifica o DATABASE_URL.');
    process.exit(1);
  }

  const destino = await openDriver({ databaseUrl: env.DATABASE_URL, sqliteFile: ficheiro });
  const origem = new DatabaseSync(ficheiro);

  // A ordem importa: mensagens e comprovativos apontam para leads.
  const plano: Array<{ tabela: string; conflito: string }> = [
    { tabela: 'leads', conflito: 'ON CONFLICT (chat_id) DO NOTHING' },
    { tabela: 'messages', conflito: 'ON CONFLICT (id) DO NOTHING' },
    { tabela: 'deposit_proofs', conflito: 'ON CONFLICT (id) DO NOTHING' },
    { tabela: 'processed_updates', conflito: 'ON CONFLICT (update_id) DO NOTHING' },
    { tabela: 'remarketing_runs', conflito: 'ON CONFLICT (slot, run_date, audience) DO NOTHING' },
  ];

  let totalFalhadas = 0;

  for (const { tabela, conflito } of plano) {
    const linhas = lerTudo(origem, tabela);
    const { copiadas, falhadas } = await copiar(destino, tabela, linhas, conflito);
    totalFalhadas += falhadas;
    log.info(`${tabela}: ${copiadas}/${linhas.length} copiadas${falhadas ? `, ${falhadas} recusadas` : ''}`);
  }

  // As sequencias do Postgres nao sabem dos ids que vieram de fora: sem isto,
  // a mensagem seguinte tentava o id 1, que ja existe, e rebentava.
  for (const tabela of ['messages', 'deposit_proofs']) {
    await destino.exec(
      `SELECT setval(pg_get_serial_sequence('${tabela}', 'id'),
                     coalesce((SELECT MAX(id) FROM ${tabela}), 1))`,
    );
  }
  log.info('sequencias de id acertadas');

  // Conferencia final: contar dos dois lados e comparar.
  for (const { tabela } of plano) {
    const antes = lerTudo(origem, tabela).length;
    const depois = await destino.get<{ total: number }>(`SELECT COUNT(*) AS total FROM ${tabela}`);
    const iguais = Number(depois?.total ?? -1) === antes;
    log.info(`${tabela}: SQLite ${antes} | Postgres ${depois?.total} ${iguais ? 'OK' : 'DIFERENTE'}`);
    if (!iguais) totalFalhadas += 1;
  }

  origem.close();
  await destino.close();

  if (totalFalhadas > 0) {
    log.error(`migracao terminada com ${totalFalhadas} problema(s). NAO apagues o SQLite.`);
    process.exit(1);
  }

  log.info('migracao concluida. O SQLite fica onde esta, para poderes voltar atras.');
  process.exit(0);
}

void main();

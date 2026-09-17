/**
 * Arranque em duas fases.
 *
 * A primeira fase nao toca na base de dados: le a mensagem fixada no canal de
 * controlo e, se o ficheiro SQLite vier vazio (o que acontece a cada deploy
 * enquanto nao houver disco persistente), repoe-o a partir do ultimo backup.
 *
 * So depois e que o servidor e carregado. A ordem importa: o modulo da base de
 * dados abre o ficheiro no momento em que e importado, e escrever por baixo de
 * um SQLite ja aberto corrompia-o.
 */
import { Api } from 'grammy';

import { env } from './config/env';
import { restoreFromChannel } from './db/backup';
import { createLogger } from './utils/logger';

const log = createLogger('arranque');

async function main(): Promise<void> {
  if (env.BACKUP_ENABLED) {
    try {
      await restoreFromChannel(new Api(env.TELEGRAM_BOT_TOKEN), env.TELEGRAM_BOT_TOKEN);
    } catch (error) {
      // Um backup que nao volta nao pode impedir o bot de arrancar: sem
      // servico, nem os leads novos entram.
      log.error('restauro do backup falhou; a arrancar na mesma', error);
    }
  }

  await import('./server');
}

void main();

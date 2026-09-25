/**
 * Backup da base de dados para o canal de controlo do Telegram.
 *
 * O disco do Render e descartado a cada deploy, e montar um disco persistente
 * exige plano pago. Enquanto isso nao acontece, os leads, o historico e o
 * estado do remarketing desaparecem a cada publicacao — ja aconteceu vezes de
 * mais nesta operacao.
 *
 * Isto usa a unica coisa que ja existe e e mesmo persistente: um canal do
 * Telegram. De hora a hora, e no encerramento, o ficheiro SQLite e enviado
 * para la como documento e FIXADO no canal. No arranque seguinte, se a base de
 * dados vier vazia, o bot le a mensagem fixada, descarrega o ficheiro e repoe
 * tudo — conversas incluidas.
 *
 * A mensagem fixada e o truque que faz isto funcionar: um bot nao consegue ler
 * o historico de um canal, mas consegue sempre ler o `pinned_message` via
 * getChat. Sem isso nao havia como encontrar o ultimo backup depois de perder
 * a base de dados que guardava o file_id.
 *
 * ISTO NAO SUBSTITUI UM DISCO PERSISTENTE. E uma rede de seguranca com uma
 * janela de perda de ate uma hora, e depende de o canal existir e de o bot
 * poder fixar mensagens la. O disco continua a ser a solucao certa.
 */
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { Api, InputFile } from 'grammy';

import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('backup');

/** Marca que identifica os backups no canal, para nao se confundirem com prints. */
const LEGENDA = '[backup automatico da base de dados do El Pedrito]';

/**
 * Canal onde o backup vive. E o mesmo destino das imagens: um canal que o
 * operador ja tem e onde o bot ja escreve.
 */
function destino(): number | null {
  return env.ADMIN_CHAT_IDS[0] ?? null;
}

/**
 * Envia o ficheiro e fixa-o, desafixando o anterior.
 *
 * O `bot` chega por parametro e nao por import para nao criar um ciclo:
 * telegram/bot.ts ja importa a base de dados.
 */
export async function backupDatabase(api: Api): Promise<boolean> {
  // Com Postgres isto teria mandado para o canal um ficheiro SQLite vazio, de
  // hora a hora, com ar de backup. Pior que nao ter rede de seguranca nenhuma
  // e ter uma que parece existir: descobria-se no dia de a usar.
  if (env.usaPostgres) return false;

  const chat = destino();

  if (chat === null) {
    log.warn('sem ADMIN_CHAT_IDS: nao ha para onde mandar o backup');
    return false;
  }

  if (env.databaseFile === ':memory:' || !existsSync(env.databaseFile)) {
    return false;
  }

  try {
    // O WAL do SQLite vive num ficheiro a parte. Um checkpoint antes de copiar
    // garante que o .sqlite sozinho ja tem tudo: sem isto o backup podia ficar
    // sem as ultimas escritas.
    checkpoint();

    const bytes = readFileSync(env.databaseFile);
    const nome = `funnel-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.sqlite`;

    const enviada = await api.sendDocument(chat, new InputFile(bytes, nome), {
      caption: `${LEGENDA}\n${bytes.length} bytes`,
      disable_notification: true,
    });

    // Desafixa o anterior antes de fixar este: o canal fica com uma unica
    // mensagem fixada, que e sempre a mais recente.
    await api.unpinChatMessage(chat).catch(() => undefined);
    await api.pinChatMessage(chat, enviada.message_id, { disable_notification: true });

    log.info(`backup enviado e fixado (${bytes.length} bytes)`);
    return true;
  } catch (error) {
    log.error('falha ao enviar o backup', error);
    return false;
  }
}

/** Forca o WAL para dentro do ficheiro principal. */
function checkpoint(): void {
  // Importado aqui e nao no topo: em tempo de arranque o modulo da base de
  // dados ainda pode nao ter corrido.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { checkpointDatabase } = require('./database') as { checkpointDatabase: () => void };
  checkpointDatabase();
}

/**
 * Repoe a base de dados a partir da mensagem fixada no canal, se a que existe
 * estiver vazia.
 *
 * Corre ANTES de o modulo da base de dados abrir o ficheiro, senao o SQLite
 * ficaria com o ficheiro velho aberto por baixo dos pes.
 */
export async function restoreFromChannel(api: Api, token: string): Promise<boolean> {
  if (env.usaPostgres) return false;

  const chat = destino();
  if (chat === null || env.databaseFile === ':memory:') return false;

  // So repoe se nao houver nada para perder. Um ficheiro com conteudo manda
  // sempre sobre o backup: repor por cima de dados bons seria perder trabalho.
  if (existsSync(env.databaseFile) && statSync(env.databaseFile).size > 0) return false;

  try {
    const info = await api.getChat(chat);
    const fixada = 'pinned_message' in info ? info.pinned_message : undefined;

    if (!fixada?.document || !fixada.caption?.includes(LEGENDA)) {
      log.info('nao ha backup fixado no canal; a comecar com a base de dados vazia');
      return false;
    }

    const ficheiro = await api.getFile(fixada.document.file_id);
    if (!ficheiro.file_path) return false;

    const resposta = await fetch(
      `https://api.telegram.org/file/bot${token}/${ficheiro.file_path}`,
    );
    if (!resposta.ok) throw new Error(`descarga falhou: ${resposta.status}`);

    const bytes = Buffer.from(await resposta.arrayBuffer());
    writeFileSync(env.databaseFile, bytes);
    closeSync(openSync(env.databaseFile, 'r'));

    log.info(`base de dados reposta do backup fixado (${bytes.length} bytes)`);
    return true;
  } catch (error) {
    log.error('falha ao repor a base de dados do canal', error);
    return false;
  }
}

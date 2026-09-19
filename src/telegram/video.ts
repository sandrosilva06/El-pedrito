/**
 * O video de apresentacao do funil.
 *
 * E a cara de quem esta por tras do grupo, gravada a falar para a camara. O
 * lugar dele no funil e uma decisao de vendas e vive no FUNNEL_VIDEO_MOMENT;
 * o que este ficheiro garante e que ele sai bem, uma vez, e que uma falha a
 * enviar nunca leva o turno do lead atras dela.
 *
 * O FICHEIRO VIVE NO REPOSITORIO
 * assets/funil/apresentacao.mp4, ao lado do codigo, e nao num disco ou num
 * bucket. Isto e de proposito: o disco do Render e efemero e ja apagou a base
 * de dados uma vez. Um ficheiro que vem com o deploy nao se perde num deploy,
 * e meio megabyte num repositorio nao custa nada a ninguem.
 *
 * O CACHE DO file_id
 * O Telegram devolve um file_id na primeira vez que se envia um ficheiro. A
 * partir dai envia-se o file_id em vez dos bytes: e uma chamada instantanea em
 * vez de um upload de meio mega por cada lead. O file_id fica guardado no
 * app_meta com a IMPRESSAO DIGITAL do ficheiro na chave — trocar o video
 * invalida o cache sozinho, sem ninguem se lembrar de o limpar. Ja houve uma
 * troca de video neste funil; vai haver outra.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { InputFile, type Api } from 'grammy';

import { env } from '../config/env';
import { addMessage, gravarMeta, lerMeta, setVideoSent } from '../db/database';
import { createLogger } from '../utils/logger';

const log = createLogger('video');

/**
 * Resolvido a partir do ficheiro e nao do cwd.
 *
 * Em desenvolvimento isto corre de src/telegram, em producao de dist/telegram,
 * e nos dois casos a pasta assets esta dois niveis acima. Com um caminho
 * relativo ao cwd, bastava alguem arrancar o processo de outra pasta para o
 * video desaparecer sem erro nenhum.
 */
export const VIDEO_PATH = path.join(__dirname, '..', '..', 'assets', 'funil', 'apresentacao.mp4');

/** Ha video para enviar? */
export function videoDisponivel(): boolean {
  return existsSync(VIDEO_PATH);
}

/**
 * Impressao digital do ficheiro, para a chave do cache.
 *
 * Lida uma vez e guardada em memoria: sao 500 KB, e re-hashar a cada lead era
 * trabalho a mais para responder sempre o mesmo.
 */
let impressaoCache: string | null = null;

function impressao(): string {
  impressaoCache ??= createHash('sha256').update(readFileSync(VIDEO_PATH)).digest('hex').slice(0, 12);
  return impressaoCache;
}

function chaveCache(): string {
  return `video_apresentacao_file_id_${impressao()}`;
}

/**
 * Envia o video ao lead, uma vez.
 *
 * Nunca lanca. O video e um extra: se o Telegram o recusar, o funil segue sem
 * ele e o lead nem da por nada. Derrubar o turno por causa de um anexo seria
 * trocar uma conversa por um video.
 *
 * Devolve true se o video saiu mesmo.
 */
export async function enviarVideoApresentacao(api: Api, chatId: number): Promise<boolean> {
  if (env.FUNNEL_VIDEO_MOMENT === 'desligado') return false;

  if (!videoDisponivel()) {
    log.warn(`nao ha video em ${VIDEO_PATH}; o funil segue sem ele`);
    return false;
  }

  const chave = chaveCache();

  try {
    // O "|| null" nao e cosmetico: quando um envio falha, a marca e limpa para
    // string vazia, e um "" passaria pelo ?? abaixo e seria enviado ao Telegram
    // como se fosse um file_id.
    const guardado = (await lerMeta(chave)) || null;

    const enviado = await api.sendVideo(chatId, guardado ?? new InputFile(VIDEO_PATH), {
      ...(env.FUNNEL_VIDEO_CAPTION ? { caption: env.FUNNEL_VIDEO_CAPTION } : {}),
      // Toca sozinho e em ciclo, como um video de rede social. Um video que
      // obriga a carregar em "play" e um video que metade das pessoas nao ve.
      supports_streaming: true,
    });

    const fileId = enviado.video?.file_id ?? null;

    if (fileId && fileId !== guardado) {
      await gravarMeta(chave, fileId);
      log.info('file_id do video guardado; os proximos envios ja nao fazem upload');
    }

    // Fica no historico para aparecer na caixa de entrada. Vai como 'sistema'
    // COM media: e assim que se distingue de uma nota interna, que e sempre
    // sem ficheiro — sem isto, o video desaparecia da conversa na app.
    await addMessage({
      chatId,
      role: 'assistant',
      content: env.FUNNEL_VIDEO_CAPTION || '[video de apresentacao]',
      author: 'sistema',
      mediaFileId: fileId,
      mediaKind: 'video',
    });

    await setVideoSent(chatId, true);

    log.info(`video de apresentacao enviado ao chat ${chatId}${guardado ? ' (por file_id)' : ' (upload)'}`);
    return true;
  } catch (error) {
    // Um file_id guardado pode deixar de servir (o Telegram expira-os em casos
    // raros). Apaga-se a marca para a proxima tentativa voltar a fazer upload,
    // em vez de ficar presa a um identificador morto para sempre.
    await gravarMeta(chave, '').catch(() => undefined);

    log.warn(`falha a enviar o video ao chat ${chatId}; o funil segue sem ele`, error);
    return false;
  }
}

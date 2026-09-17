/**
 * Preenche os nomes dos leads a partir do Telegram.
 *
 * Os leads recuperados dos logs vinham so com o chat_id, porque e a unica
 * coisa que os logs guardam. Na caixa de entrada apareciam como "#8962954467",
 * que nao serve para ninguem: quem abre a app quer saber com quem esta a
 * falar.
 *
 * O getChat devolve first_name, last_name e username de qualquer pessoa que
 * tenha falado com o bot — nao e preciso guardar nada, o Telegram sabe. E a
 * unica coisa que se consegue mesmo recuperar depois de perder a base de
 * dados.
 *
 * Corre em fundo no arranque e vai devagar de proposito: sao dezenas de
 * chamadas seguidas a mesma API, e um 429 por afobamento atrasaria as
 * mensagens dos leads que estao a falar agora.
 */
import type { Api } from 'grammy';

import { leadsSemNome, setIdentity } from '../db/database';
import { createLogger } from '../utils/logger';

const log = createLogger('identidades');

/** Pausa entre chamadas. O Telegram tolera ~30/s; 250ms e folgado de propósito. */
const INTERVALO_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Vai buscar o nome de quem esta sem nome.
 *
 * Devolve quantos ficaram preenchidos. Nunca lanca: um lead que o Telegram
 * recuse (bloqueou o bot, apagou a conta) e saltado, e os outros seguem.
 */
export async function preencherNomes(api: Api, limite = 200): Promise<number> {
  const pendentes = leadsSemNome(limite);
  if (pendentes.length === 0) return 0;

  log.info(`${pendentes.length} lead(s) sem nome; a perguntar ao Telegram`);

  let preenchidos = 0;

  for (const chatId of pendentes) {
    try {
      const chat = await api.getChat(chatId);

      // getChat devolve varios tipos de chat. So um chat privado tem nome de
      // pessoa; um grupo tem "title", que nao e o que procuramos aqui.
      if (chat.type !== 'private') continue;

      const firstName = chat.first_name ?? null;
      const lastName = chat.last_name ?? null;
      const username = chat.username ?? null;

      if (!firstName && !username) continue;

      setIdentity(chatId, { firstName, lastName, username });
      preenchidos += 1;
    } catch (error) {
      // Bloqueou o bot, apagou a conta, ou o id ja nao existe. Nao ha nada a
      // fazer e nao vale a pena encher os logs de erros por isso.
      log.debug(`sem identidade para o chat ${chatId}`, error);
    }

    await sleep(INTERVALO_MS);
  }

  log.info(`identidades preenchidas: ${preenchidos}/${pendentes.length}`);
  return preenchidos;
}

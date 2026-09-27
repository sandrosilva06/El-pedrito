import { env } from '../config/env';
import {
  addMessage,
  claimRemarketingSlot,
  clearDepositPromise,
  getDuePromises,
  getRemarketingTargets,
  markBlocked,
  markRemarketed,
  recordRemarketingSent,
  type Lead,
  type RemarketingAudience,
} from '../db/database';
import {
  NAO_CONVERTIDO_TOUCHES,
  TOQUE_PERSISTENTE,
  generateRemarketingMessage,
  personalise,
} from '../services/remarketing';
import { createLogger } from '../utils/logger';
import { IDS_PERSONA, type IdPersona } from '../personas/ids';
import { canalDe, canalParaChat } from '../telegram/canal';
import { nowInTimezone } from '../utils/timezone';
import { bot } from '../telegram/bot';

const log = createLogger('agendador');

// O link_parado vem primeiro: e o balde mais quente e o que mais se perde.
const AUDIENCES: RemarketingAudience[] = ['link_parado', 'nao_convertido', 'vip'];

/** Tecto por slot: uma campanha nao deve inundar a API do Telegram de uma vez. */
const BATCH_LIMIT = 200;

/** Pausa entre envios, para nao atirar a campanha toda de uma vez ao Telegram. */
const SEND_INTERVAL_MS = env.REMARKETING_SEND_INTERVAL_MS;

/**
 * Tecto de toques a quem nao converteu. Fica travado no numero de guioes
 * escritos: um toque a mais sairia sem texto proprio, e a variavel de ambiente
 * pode estar posta num valor antigo num deploy que ja esta a correr.
 */
/**
 * Quantos toques um lead que nao converteu leva.
 *
 * Deixou de estar limitado ao numero de guioes escritos: o ultimo guiao e o
 * PERSISTENTE, feito para se repetir mudando de angulo. Quem nao depositou
 * continua a ser trabalhado ate depositar ou bloquear — e sao essas as duas
 * unicas saidas, ambas tratadas em codigo (o estagio tira-o da lista, o 403 do
 * Telegram marca-o como bloqueado).
 */
const MAX_TOUCHES = env.REMARKETING_MAX_TOUCHES;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseSlots(): string[] {
  return env.REMARKETING_SLOTS.split(',')
    .map((slot) => slot.trim())
    .filter((slot) => /^\d{2}:\d{2}$/.test(slot));
}

/**
 * Um slot esta "a vencer" quando a hora atual ja o passou, no mesmo dia. Nao
 * se exige a coincidencia exata do minuto: se o servico esteve a dormir a
 * essa hora — o que acontece em plano gratuito — o envio sai no primeiro
 * despertar em vez de se perder o dia.
 */
function dueSlot(time: string, slots: string[]): string | null {
  const due = slots.filter((slot) => slot <= time).sort();
  return due[due.length - 1] ?? null;
}

async function sendToAudience(
  persona: IdPersona,
  audience: RemarketingAudience,
  slot: string,
  date: string,
): Promise<void> {
  // A reserva e por (slot, dia, publico) e vive na base de dados: o Render
  // reinicia o servico a toda a hora, e sem isto cada reinicio dentro da
  // janela reenviaria a campanha inteira.
  if (!await claimRemarketingSlot(slot, date, audience, persona)) return;

  // O VIP e o link_parado sao listas so; quem nao converteu corre toque a
  // toque, porque cada toque tem o seu texto e a sua janela de tempo.
  //
  // O toque do link_parado conta no mesmo contador, de proposito: assim um lead
  // que o receba fica com um dos dois toques gastos e nunca leva mais do que as
  // duas mensagens automaticas combinadas.
  const touches = audience === 'nao_convertido' ? [...Array(MAX_TOUCHES).keys()] : [0];

  let sent = 0;
  let considered = 0;

  for (const touch of touches) {
    const targets = await getRemarketingTargets({
      persona,
      audience,
      touch,
      // Primeiro toque: conta desde a ultima coisa que o lead disse. Segundo:
      // continua a exigir o mesmo silencio, mais o intervalo desde o toque 1.
      coldHours:
        audience === 'link_parado'
          ? env.REMARKETING_LINK_STALLED_HOURS
          : env.REMARKETING_FIRST_TOUCH_HOURS,
      sinceLastTouchHours:
        audience === 'link_parado'
          ? env.REMARKETING_LINK_STALLED_HOURS
          : audience === 'vip'
            ? env.REMARKETING_QUIET_HOURS
            : touch === 0
              ? env.REMARKETING_FIRST_TOUCH_HOURS
              : env.REMARKETING_SECOND_TOUCH_HOURS,
      limit: BATCH_LIMIT,
    });

    if (targets.length === 0) continue;

    considered += targets.length;

    // Do terceiro toque em diante e sempre o guiao persistente: e o unico
    // escrito para se repetir sem cansar.
    const guiao = audience === 'nao_convertido' ? Math.min(touch, TOQUE_PERSISTENTE) : touch;

    const { template, generated } = await generateRemarketingMessage(audience, guiao);
    log.info(
      `slot ${slot} (${audience}, toque ${touch + 1}): ${targets.length} leads, ` +
        `mensagem ${generated ? 'gerada' : 'de reserva'}`,
    );

    for (const lead of targets) {
      const delivered = await sendOne(persona, lead, template);
      if (delivered) sent += 1;

      // A pausa fica DENTRO da fila e nao entre toques: e o ritmo de entrega
      // ao Telegram que interessa, nao a fronteira entre as duas listas.
      await sleep(SEND_INTERVAL_MS);
    }
  }

  if (considered === 0) {
    log.info(`slot ${slot} ${persona} (${audience}): nenhum lead elegivel`);
    return;
  }

  await recordRemarketingSent(slot, date, audience, sent, persona);
  log.info(`slot ${slot} ${persona} (${audience}): ${sent}/${considered} entregues`);
}

async function sendOne(persona: IdPersona, lead: Lead, template: string): Promise<boolean> {
  const text = personalise(template, lead.firstName);

  try {
    // Pelo canal do lead e nao pela Bot API.
    //
    // Isto era um bug com dinheiro la dentro: os leads do El Pedrito chegam
    // pela CONTA de utilizador, e um bot nao consegue escrever a quem nunca lhe
    // fez /start. O envio falhava com "chat not found", o bloco abaixo lia isso
    // como um bloqueio, e o lead saia de TODAS as campanhas para sempre. Leads
    // bons, pagos a anuncio, riscados por uma mensagem que nunca foi entregue.
    const canal = await canalParaChat(lead.chatId, persona);
    await canal.enviar(lead.chatId, text);

    // Gravado no historico depois de entregue. Sem isto o lead via no telemovel
    // mensagens que nao existiam em lado nenhum: a caixa de entrada mostrava
    // uma conversa diferente da real, e as IAs tambem nao sabiam o que ja lhe
    // tinha sido dito.
    await addMessage({
      chatId: lead.chatId,
      persona,
      role: 'assistant',
      content: text,
      author: 'sistema',
    });
    await markRemarketed(lead.chatId, persona);
    return true;
  } catch (error) {
    const description =
      (error as { description?: string })?.description ?? (error as Error)?.message ?? '';

    // So estes dois dizem MESMO que o lead nos pos fora. O "chat not found" saiu
    // daqui de proposito: quer dizer que nao ha conversa por aquele caminho, o
    // que e um problema de transporte nosso e nao uma decisao do lead.
    if (/bot was blocked|user is deactivated/i.test(description)) {
      await markBlocked(lead.chatId, persona);
      log.info(`lead ${lead.chatId} (${persona}) bloqueou o bot; retirado da lista`);
      return false;
    }

    // A descricao vai para o log: era o que faltava para distinguir um bloqueio
    // de um erro nosso sem ter de adivinhar.
    log.warn(`falha ao enviar remarketing a ${lead.chatId} (${persona})`, description || error);
    return false;
  }
}

/**
 * Lembretes individuais de promessa de deposito. Corre a cada minuto, nao nos
 * slots: a hora foi combinada com cada lead e um slot fixo chegaria horas ao
 * lado do que ficou prometido.
 *
 * Ao contrario do remarketing em massa, este lembrete ignora as horas de
 * silencio — o lead pediu-o ("apitas-me aqui"), e o silencio existe para nao
 * incomodar quem nao pediu nada.
 */
async function sendDuePromises(persona: IdPersona): Promise<void> {
  const due = await getDuePromises(persona, new Date().toISOString(), 100);
  if (due.length === 0) return;

  const { template, generated } = await generateRemarketingMessage('promessa');
  log.info(`${due.length} promessa(s) vencida(s), mensagem ${generated ? 'gerada' : 'de reserva'}`);

  for (const lead of due) {
    // Limpa antes de enviar: se o envio falhar, o lead nao fica a receber o
    // mesmo lembrete a cada minuto ate ao fim dos tempos.
    await clearDepositPromise(lead.chatId, persona);

    const delivered = await sendOne(persona, lead, template);
    log.info(
      `lembrete de promessa chat=${lead.chatId} (${lead.promiseNote ?? '?'}) ` +
        `${delivered ? 'entregue' : 'falhou'}`,
    );

    await sleep(SEND_INTERVAL_MS);
  }
}

async function tick(): Promise<void> {
  const slots = parseSlots();
  const { time, date } = nowInTimezone(env.REMARKETING_TIMEZONE);
  const slot = slots.length > 0 ? dueSlot(time, slots) : null;

  // Cada influencer corre a sua campanha, com as suas listas e o seu guiao. Um
  // `for` e nao um Promise.all: sao envios para o Telegram, e disparar duas
  // campanhas ao mesmo tempo era pedir para levar 429.
  for (const persona of personasComCanal()) {
    try {
      await sendDuePromises(persona);
    } catch (error) {
      log.error(`falha ao enviar lembretes de promessa (${persona})`, error);
    }

    if (!slot) continue;

    for (const audience of AUDIENCES) {
      try {
        await sendToAudience(persona, audience, slot, date);
      } catch (error) {
        log.error(`falha no slot ${slot} ${persona} (${audience})`, error);
      }
    }
  }
}

/**
 * Os influencers que tem por onde enviar agora.
 *
 * Correr a campanha de um influencer sem canal ligado nao dava erro nenhum —
 * gastava a reserva do slot do dia e o lead nunca recebia nada. Melhor nao
 * comecar.
 */
function personasComCanal(): IdPersona[] {
  return IDS_PERSONA.filter((persona) => {
    try {
      canalDe(persona === 'ivan' ? 'bot_ivan' : 'bot');
      return true;
    } catch {
      return false;
    }
  });
}

let timer: NodeJS.Timeout | null = null;

export function startRemarketingScheduler(): void {
  if (!env.REMARKETING_ENABLED) {
    log.info('remarketing desligado (REMARKETING_ENABLED=false)');
    return;
  }

  const slots = parseSlots();

  if (slots.length === 0) {
    log.warn(`REMARKETING_SLOTS invalido: "${env.REMARKETING_SLOTS}". Agendador parado.`);
    return;
  }

  log.info(
    `remarketing activo — slots ${slots.join(', ')} (${env.REMARKETING_TIMEZONE}), ` +
      `ate ${MAX_TOUCHES} toque(s) por lead que nao converteu, a cada ` +
      `${env.REMARKETING_SECOND_TOUCH_HOURS}h de silencio ` +
      `(o 1.o as ${env.REMARKETING_FIRST_TOUCH_HOURS}h), ate depositar ou bloquear, ` +
      `${SEND_INTERVAL_MS}ms entre envios, ` +
      'lembretes de promessa a cada minuto',
  );

  void tick();
  timer = setInterval(() => void tick(), 60_000);
}

export function stopRemarketingScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

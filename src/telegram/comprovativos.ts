/**
 * O caminho de uma imagem que um lead manda, partilhado pelos dois influencers.
 *
 * Nasceu dentro do `bot.ts` e vivia so para o El Pedrito. O bot do Ivan, quando
 * chegou, tinha um handler de imagem que respondia "Recebido" e mais nada: o
 * print nao era guardado, nao ia para canal nenhum e ninguem ficava a saber que
 * aquele lead tinha depositado. Ele esperava por uma validacao que nao tinha
 * sido pedida a ninguem.
 *
 * O que muda entre os dois nao e o caminho — e o DESTINO. Cada persona tem o
 * seu canal de administracao e o seu bot para la escrever, porque o bot de um
 * nao e membro do canal do outro. Dai o registo de avisadores em baixo, em vez
 * de um `bot.api` fixo no modulo.
 */
import { env } from '../config/env';
import {
  addMessage,
  advanceStage,
  clearDepositPromise,
  recordDepositProof,
  setHumanHandover,
  type Lead,
} from '../db/database';
import type { IdPersona } from '../personas/ids';
import type { Persona } from '../personas/types';
import { sentidoDaImagem } from '../utils/legenda';
import { createLogger } from '../utils/logger';

const log = createLogger('comprovativos');

/** O que a legenda diz que a imagem e. A imagem sozinha nao diz nada. */
export type SentidoDaImagem = 'comprovativo' | 'problema' | 'indefinido';

/**
 * Por onde se fala com o canal de administracao de uma persona.
 *
 * Nao e o `Canal` do lead: aquele so leva texto e, no caso do El Pedrito, sai
 * por uma conta de utilizador. Um comprovativo reencaminha-se por `file_id`, o
 * que exige um bot.
 */
export interface Avisador {
  texto(chatId: number, texto: string): Promise<void>;
  foto(chatId: number, fileId: string, legenda: string): Promise<void>;
  documento(chatId: number, fileId: string, legenda: string): Promise<void>;
}

const avisadores = new Map<IdPersona, Avisador>();

/** Cada bot regista o seu no arranque. Sem isto a persona nao avisa ninguem. */
export function registarAvisador(persona: IdPersona, avisador: Avisador): void {
  avisadores.set(persona, avisador);
}

/** So para os testes: esquece o que foi registado. */
export function esquecerAvisadores(): void {
  avisadores.clear();
}

/**
 * Para onde vao os comprovativos desta persona.
 *
 * O Ivan recua para o canal do El Pedrito quando nao tem o seu configurado: e
 * melhor o print chegar ao canal errado, onde alguem o ve e percebe, do que
 * ficar guardado numa tabela que ninguem abre.
 */
function destinosDe(persona: IdPersona): number[] {
  if (persona === 'ivan') {
    return env.IVAN_ADMIN_CHAT_IDS.length > 0 ? env.IVAN_ADMIN_CHAT_IDS : env.ADMIN_CHAT_IDS;
  }

  return env.ADMIN_CHAT_IDS;
}

/**
 * Avisa-o de que uma conversa passou para as maos dele.
 *
 * Sem isto a entrega era silenciosa: o bot calava-se e o lead ficava a espera
 * de uma resposta que so aparecia se alguem abrisse a app por acaso.
 */
export async function avisarDaEntrega(
  persona: IdPersona,
  lead: Lead,
  incoming: string,
  /**
   * Porque e que a conversa foi entregue.
   *
   * A omissao e o texto de sempre — o lead que falou em dinheiro que nao tem —
   * para quem ja chama esta funcao nao mudar. O `detalhe` e o que da a quem vai
   * pegar na conversa o que ele precisa sem abrir a base de dados: no caso das
   * casas, quais e que ja estao queimadas. Sem isso ele le "ja tenho conta" e
   * fica exactamente onde o bot ficou.
   */
  motivo: { titulo: string; detalhe?: string } = {
    titulo: 'o lead falou em dinheiro que nao tem',
  },
): Promise<void> {
  const destinos = destinosDe(persona);
  const avisador = avisadores.get(persona);

  if (destinos.length === 0 || !avisador) {
    log.error(
      `conversa do chat ${lead.chatId} (${persona}) entregue a mao, mas nao ha por onde ` +
        'avisar: ve a caixa de entrada',
    );
    return;
  }

  const texto =
    `Conversa entregue a ti — ${motivo.titulo}\n\n` +
    (motivo.detalhe ? `${motivo.detalhe}\n\n` : '') +
    `Persona: ${persona}\n` +
    `Nome: ${lead.firstName || '(sem nome)'}\n` +
    `Username: ${lead.username ? `@${lead.username}` : '(sem username)'}\n` +
    `ID: ${lead.chatId}\n\n` +
    `Ultima mensagem dele:\n"${incoming.slice(0, 500)}"\n\n` +
    'O bot esta calado nesta conversa. Responde-lhe pela caixa de entrada.';

  for (const destino of destinos) {
    try {
      await avisador.texto(destino, texto);
    } catch (error) {
      log.error(`falha ao avisar ${destino} da entrega do chat ${lead.chatId}`, error);
    }
  }
}

/**
 * Encaminha o comprovativo a quem valida. Sem isto o registo ficaria so na base
 * de dados e o lead esperaria por alguem que nao sabe que ele existe.
 */
export async function avisarDoComprovativo(
  persona: IdPersona,
  proofId: number,
  lead: Lead,
  fileId: string,
  fileKind: 'photo' | 'document',
  sentido: SentidoDaImagem = 'indefinido',
): Promise<void> {
  const destinos = destinosDe(persona);
  const avisador = avisadores.get(persona);

  if (destinos.length === 0 || !avisador) {
    log.error(
      `sem destino de administracao para ${persona}: comprovativo #${proofId} guardado, ` +
        'mas ninguem foi avisado',
    );
    return;
  }

  // "FEITO" a cabeca quando o lead o escreveu: e o que a equipa de analise
  // procura para saber que aquele print e um deposito para validar, e nao mais
  // uma imagem qualquer a precisar de ser lida.
  const cabecalho =
    sentido === 'comprovativo'
      ? 'FEITO — deposito para validar'
      : sentido === 'problema'
        ? `Imagem #${proofId} — o lead reportou um PROBLEMA (o funil esta a ajudar)`
        : `Imagem #${proofId} — por validar`;

  const legenda =
    `${cabecalho}\n\n` +
    `Persona: ${persona}\n` +
    `Nome: ${lead.firstName ?? '(sem nome)'}\n` +
    `Username: ${lead.username ? `@${lead.username}` : '(sem username)'}\n` +
    `ID: ${lead.chatId}`;

  let entregues = 0;

  for (const destino of destinos) {
    try {
      // Reenvia por file_id: sem download nem reupload do ficheiro. Um PDF
      // enviado por sendPhoto seria recusado, dai distinguir o tipo.
      if (fileKind === 'photo') {
        await avisador.foto(destino, fileId, legenda);
      } else {
        await avisador.documento(destino, fileId, legenda);
      }

      entregues += 1;
    } catch (error) {
      log.error(`falha ao enviar o comprovativo #${proofId} para ${destino}`, error);

      // Sem o ficheiro, pelo menos os dados do lead chegam — dao para o
      // encontrar a mao pelo ID.
      try {
        await avisador.texto(destino, `${legenda}\n\n(o ficheiro nao pode ser reenviado)`);
        entregues += 1;
      } catch (recuoFalhado) {
        log.error(`nem o aviso de texto chegou a ${destino}`, recuoFalhado);
      }
    }
  }

  if (entregues === 0) {
    // O lead ficou a espera de uma validacao que nao foi pedida a ninguem.
    log.error(
      `comprovativo #${proofId} nao chegou a nenhum destino de administracao. ` +
        `Confirma que o bot do ${persona} pertence ao canal e tem permissao para publicar.`,
    );
  }
}

/**
 * Guarda a imagem, escreve-a na conversa e avisa quem valida.
 *
 * NAO responde ao lead e NAO decide o que fazer a seguir: isso e de cada bot,
 * porque as personas divergem — o El Pedrito cala-se e o Ivan acusa a recepcao.
 * Devolve o sentido lido da legenda para o chamador poder decidir.
 */
export async function receberImagem(
  persona: Persona,
  lead: Lead,
  imagem: {
    fileId: string;
    tipo: 'photo' | 'document';
    messageId: number;
    legenda: string;
  },
): Promise<{ proofId: number; sentido: SentidoDaImagem }> {
  const proof = await recordDepositProof({
    chatId: lead.chatId,
    persona: persona.id,
    leadName: lead.firstName,
    username: lead.username,
    fileId: imagem.fileId,
    messageId: imagem.messageId,
  });

  // Ele mexeu-se: nao faz sentido apitar-lhe o lembrete de deposito a seguir.
  await clearDepositPromise(lead.chatId, persona.id);

  // A LEGENDA E QUE DECIDE o que a imagem e. A imagem sozinha nao diz nada:
  // ja aconteceu o bot agradecer um "deposito" que era um print de um erro, e
  // o lead bloqueou, com razao.
  const legenda = imagem.legenda.trim();
  const sentido = sentidoDaImagem(legenda);

  await addMessage({
    chatId: lead.chatId,
    persona: persona.id,
    role: 'user',
    content:
      legenda.length > 0
        ? legenda
        : '[o lead enviou uma imagem; ninguem lhe respondeu e ainda nao se sabe o que ela mostra]',
    author: legenda.length > 0 ? 'bot' : 'sistema',
    // O file_id vai junto para a caixa de entrada poder mostrar a imagem. Ate
    // aqui ele so existia em deposit_proofs, que a caixa nao le, e a conversa
    // ficava com um marcador de texto onde o lead tinha mandado um print.
    mediaFileId: imagem.fileId,
    mediaKind: imagem.tipo,
  });

  if (sentido === 'comprovativo') {
    await advanceStage(lead.chatId, persona.id, 'comprovativo_recebido');
  }

  if (sentido !== 'problema') {
    // Comprovativo ou imagem sem explicacao: a IA fica calada. Validar um
    // deposito e uma decisao de uma pessoa, tomada fora do que o bot ve.
    await setHumanHandover(lead.chatId, persona.id, true);
  }

  await avisarDoComprovativo(persona.id, proof.id, lead, imagem.fileId, imagem.tipo, sentido);

  return { proofId: proof.id, sentido };
}

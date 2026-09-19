/**
 * Apagar as conversas todas e ficar so com as que vierem a seguir.
 *
 * Isto e destrutivo e irreversivel: as conversas antigas nao existem em mais
 * lado nenhum. Foi pedido duas vezes, em palavras que nao deixam duvida
 * ("apaga as conversas todas com os leads do el pedrito e deixa so as
 * proximas"), por isso corre SOZINHO no primeiro arranque depois deste
 * commit. Nao ha variavel para ligar nem passo para ninguem se lembrar de dar.
 *
 * COMO FUNCIONA A MARCA
 * O token da limpeza — a constante abaixo, ou a WIPE_TOKEN se estiver definida
 * — fica guardado na tabela app_meta depois de a limpeza correr. No arranque
 * seguinte o token e o valor guardado sao iguais, e nao se apaga nada.
 *
 * Esta parte e a que interessa mesmo: sem ela, cada deploy do Render repetia a
 * limpeza e apagava as conversas NOVAS, que sao exactamente as que se queria
 * manter. O pedido era "deixa so as proximas", e "as proximas" comecam no
 * instante em que isto corre uma vez.
 *
 * Para voltar a limpar mais tarde ha dois caminhos: mudar a constante abaixo
 * (um deploy) ou definir a WIPE_TOKEN com um valor novo (sem deploy). Um token
 * novo, uma limpeza.
 *
 * O QUE NAO SE APAGA
 * Os leads do VIP_CHAT_IDS — quem ja depositou, ja foi aprovado a mao e ja
 * esta dentro do grupo. Esses ficam, no estagio certo e afixados. Apagar um
 * cliente que ja pagou para o bot lhe recomecar o funil e um estrago que nao
 * se desfaz, e nada no pedido pedia isso.
 *
 * As mensagens deles sao apagadas como as dos outros, mas o arranque volta a
 * por a marca interna de "lead ja validado" na conversa vazia (restoreVipLeads),
 * portanto o bot continua a saber com quem esta a falar.
 */
import { env } from '../config/env';
import { apagarConversas, gravarMeta, lerMeta } from './database';
import { createLogger } from '../utils/logger';

const log = createLogger('limpeza');

/** Chave em app_meta onde fica o token da ultima limpeza feita. */
export const CHAVE_LIMPEZA = 'conversas_limpas_token';

/**
 * A limpeza que foi pedida, identificada pela data em que foi pedida.
 *
 * Enquanto este valor for o que esta guardado na base de dados, nao acontece
 * nada. Mudar esta linha e o que pede uma limpeza nova — e e por isso que ela
 * traz a data: daqui a tres meses tem de se perceber, so de a ler, qual foi a
 * limpeza que ja correu.
 */
export const LIMPEZA_PEDIDA = 'conversas-2026-09-19';

export interface ResultadoLimpeza {
  /** Apagou mesmo alguma coisa nesta corrida? */
  executada: boolean;
  leadsApagados: number;
  mensagensApagadas: number;
  leadsMantidos: number;
}

const NADA_FEITO: ResultadoLimpeza = {
  executada: false,
  leadsApagados: 0,
  mensagensApagadas: 0,
  leadsMantidos: 0,
};

/**
 * Ja se limpou alguma vez nesta base de dados?
 *
 * O arranque usa isto para NAO voltar a repor os leads reconstruidos dos logs:
 * depois de uma limpeza pedida a mao, trazer de volta 86 conversas vazias de
 * leads antigos seria desfazer o que acabou de ser feito.
 */
export async function jaLimpou(): Promise<boolean> {
  return (await lerMeta(CHAVE_LIMPEZA)) !== null;
}

/**
 * Corre a limpeza se — e so se — o token for diferente do que ja foi feito.
 *
 * O token vem da constante acima, ou da WIPE_TOKEN quando ela existe (para
 * poder pedir-se outra limpeza sem deploy). A lista de protegidos vem da
 * configuracao. Os dois podem ser passados a mao, que e como os testes
 * conseguem exercer varias limpezas seguidas sem recarregar o ambiente.
 *
 * Devolve sempre um resultado; nunca lanca. Uma falha a apagar nao pode
 * impedir o bot de atender leads.
 */
export async function limparConversas(opcoes: {
  token?: string | null;
  protegidos?: number[];
} = {}): Promise<ResultadoLimpeza> {
  const token = opcoes.token !== undefined ? opcoes.token : (env.WIPE_TOKEN ?? LIMPEZA_PEDIDA);

  if (!token) return NADA_FEITO;

  const feito = await lerMeta(CHAVE_LIMPEZA);

  if (feito === token) {
    log.debug(`limpeza "${token}" ja tinha sido feita; nada a fazer`);
    return NADA_FEITO;
  }

  // Quem fica: os leads que ja pagaram e ja estao dentro do grupo.
  const protegidos = opcoes.protegidos ?? env.vipLeads.map((lead) => lead.chatId);

  let apagado;

  try {
    apagado = await apagarConversas(protegidos);
  } catch (error) {
    // Sem marca gravada, o arranque seguinte volta a tentar. O que nao pode
    // acontecer e o bot ficar em baixo por causa disto: um funil parado custa
    // leads a serio, uma limpeza adiada nao custa nada.
    log.error('a limpeza falhou; fica por fazer e tenta-se no arranque seguinte', error);
    return NADA_FEITO;
  }

  const resultado: ResultadoLimpeza = { executada: true, ...apagado };

  // A marca e gravada DEPOIS de apagar, e fora da transacao de proposito: se a
  // limpeza falhar a meio, a marca nao fica, e o arranque seguinte tenta outra
  // vez. O contrario — marca gravada com a limpeza por fazer — deixava conversas
  // antigas para sempre.
  await gravarMeta(CHAVE_LIMPEZA, token);

  log.warn(
    `conversas apagadas (token "${token}"): ${resultado.leadsApagados} lead(s) e ` +
      `${resultado.mensagensApagadas} mensagem(ns). ` +
      `Ficaram ${resultado.leadsMantidos} lead(s) protegido(s) do VIP_CHAT_IDS.`,
  );

  return resultado;
}

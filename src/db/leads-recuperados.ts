/**
 * Leads recuperados dos logs de producao.
 *
 * A base de dados vivia dentro da pasta da aplicacao e foi apagada por deploys
 * sucessivos. Isto e o que se conseguiu reconstruir a partir dos logs do
 * Render, extraidos a 17/09/2026 e limitados a retencao de 30 dias da
 * plataforma.
 *
 * O QUE ESTA AQUI: o chat_id de cada lead que alguma vez carregou em /start, e
 * o estagio mais avancado que se lhe conhece. Os logs registam
 * "respondido chat=<id> estagio=<estagio>", e e dai que isto vem.
 *
 * O QUE NAO ESTA, E NAO HA MANEIRA DE RECUPERAR: o texto das conversas. Os
 * logs nunca gravaram conteudo de mensagens (de proposito — sao conversas de
 * pessoas reais), o Telegram nao serve o historico de entregas de webhook
 * passadas, e nao havia backup nenhum da base de dados. Quem disser o
 * contrario esta a prometer o que nao consegue entregar.
 *
 * Restaurar isto devolve os leads a caixa de entrada e ao remarketing, no
 * estagio certo, e impede que o bot os trate como desconhecidos e recomece o
 * funil com quem ja estava adiantado.
 */
import type { FunnelStage } from './database';

export interface LeadRecuperado {
  chatId: number;
  /** Estagio mais avancado visto nos logs. */
  stage: FunnelStage;
}

/**
 * Os tres leads que chegaram ao fim do funil. Sao os unicos em que o estagio
 * importa mesmo: vender outra vez a quem ja pagou e a pior coisa que o bot
 * pode fazer.
 */
const CONVERTIDOS: LeadRecuperado[] = [
  { chatId: 6396251578, stage: 'acesso_liberado' },
  { chatId: 5923999830, stage: 'acesso_liberado' },
  { chatId: 739726043, stage: 'comprovativo_recebido' },
];

/**
 * Todos os outros. Voltam em 'qualificacao' e nao no estagio exacto: sem o
 * historico, por um lado o estrategista nao tem contexto nenhum para continuar
 * de onde ficou, e por outro um lead reposto em 'registo_enviado' levaria com
 * "ja abriste o link?" sobre um link que nao faz ideia de ter recebido.
 *
 * A marca que o restauro deixa no historico diz ao bot que ja houve conversa e
 * que e proibido repetir a apresentacao.
 */
const RESTANTES: number[] = [
  67413013, 219009151, 227309557, 377310630, 565552343, 605276317, 702523693,
  741915374, 756042556, 968339272, 987433485, 1030973624, 1032952849, 1035633843,
  1049351243, 1074048656, 1108906377, 1128855506, 1169456029, 1262984675,
  1303212312, 1315942035, 1505215909, 1548965783, 1566239980, 1579056252,
  1621891738, 1622713228, 1706267836, 1837020635, 1954380349, 1958556499,
  1989537428, 2019325400, 2078827325, 2087175871, 5111576761, 5193871450,
  5194920226, 5433377729, 5488242041, 5602486870, 5624388355, 5657583624,
  5713010055, 5745502044, 5841679604, 5851021951, 5968690899, 5992680114,
  5995664907, 6125780559, 6172437693, 6208979747, 6274367627, 6498681117,
  6622994404, 6652241617, 6664687754, 6874603086, 6885539336, 6949102418,
  7069292614, 7137927613, 7141576377, 7156050097, 7204809135, 7292381085,
  7378443480, 7531490155, 7691672875, 7901833090, 8176402610, 8207292395,
  8349883049, 8362648884, 8403795474, 8419221026, 8584114417, 8761302396,
  8869367534, 8902964555, 8962954467,
];

export const LEADS_RECUPERADOS: LeadRecuperado[] = [
  ...CONVERTIDOS,
  ...RESTANTES.map((chatId): LeadRecuperado => ({ chatId, stage: 'qualificacao' })),
];

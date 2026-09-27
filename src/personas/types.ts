/**
 * Tudo o que muda entre influencers.
 *
 * O motor e comum — a fila de mensagens, o ritmo de escrita, o sanitizador, o
 * agendador, a base de dados. So isto varia.
 *
 * Cada persona vive no seu ficheiro e NAO conhece as outras: mexer numa nao
 * pode mudar o comportamento de outra que ja esta a converter leads. E a razao
 * pela qual isto e uma interface e nao um `if (persona === 'ivan')` espalhado
 * pelo codigo.
 */
import type { Lead, RemarketingAudience, StoredMessage } from '../db/database';
import type { IdPersona } from './ids';

/** Uma casa por onde o lead se pode registar. */
export interface PersonaHouse {
  /** Identificador que o estrategista devolve em `affiliateHouse`. */
  id: string;
  /** Nome como o lead o ve. */
  label: string;
  link: string;
}

/**
 * Os factos do lead que o funil usa para saber o que ainda falta perguntar.
 *
 * Um `Pick` e nao o Lead inteiro para deixar claro, a quem le, que estas
 * funcoes decidem so a partir da memoria do lead e nao do resto do estado.
 */
export type LeadComFactos = Pick<
  Lead,
  | 'canton' | 'job' | 'bettingExperience' | 'tratamento' | 'nomePerguntado'
  | 'atencao' | 'tempoSuica' | 'oficioPedrito' | 'perguntasFeitas'
>;

/** Uma pergunta do funil, com a resposta quando ja houver. */
export interface PerguntaFunil {
  /** O que fica guardado em perguntas_feitas quando a pergunta sai. */
  chave: string;
  campo: string;
  valor: string | null;
  pergunta: string;
}

export interface Persona {
  id: IdPersona;
  agentName: string;

  /** Instrucoes de sistema do estrategista. */
  strategistSystem: string;
  /** Instrucoes de sistema do redator. */
  writerPersona: string;

  /**
   * As perguntas do funil deste influencer, pela ordem em que se fazem.
   *
   * Fica na persona e nao no motor porque sao perguntas DIFERENTES: o El Pedrito
   * quer saber ha quanto tempo o lead esta na Suica e em que trabalha; o Ivan
   * quer saber o que ele procura e se ja tem conta na casa principal. Um motor
   * com as duas listas la dentro acabava a perguntar ao lead do Ivan em que
   * canton vive.
   */
  perguntas(lead: LeadComFactos): PerguntaFunil[];

  /**
   * O bloco do prompt que diz em que ponto da conversa se esta, o que ja se sabe
   * do lead e o que e proibido voltar a perguntar.
   *
   * Tambem e conteudo: fala do grupo, do que o influencer faz da vida e do que
   * ele nao e (conselheiro, assistente social).
   */
  blocoDeFase(lead: LeadComFactos, history: StoredMessage[]): string;

  /**
   * As linhas de CONTEXTO DO LEAD que sao deste influencer.
   *
   * O motor monta o contexto comum (chat_id, nome, estagio, turno, notas) e pede
   * a persona o resto. Sem isto, o prompt do Ivan levava "ha quanto tempo esta
   * na Suica" e "em que TU (Pedrito) trabalhaste" — que e o funil do outro, dito
   * ao modelo como se fosse o dele.
   */
  contextoDoLead(lead: Lead): string;

  /**
   * Preparacao de um lead novo, se este influencer precisar de alguma.
   *
   * Existe por causa do oficio do El Pedrito, escolhido a sorte uma vez por lead
   * e guardado para ele nao dizer obras num turno e restauracao tres turnos
   * depois. O Ivan nao tem nada disto, e ausente nao corre nada.
   */
  prepararLead?(lead: Lead): Promise<void>;

  /**
   * Casas disponiveis, a principal primeiro. Vazio significa casa unica, com o
   * link em `defaultLink`.
   */
  houses: PersonaHouse[];
  /** Link usado quando a diretriz nao escolheu casa nenhuma. */
  defaultLink: string;

  /**
   * Quantas mensagens seguidas este influencer manda, no maximo.
   *
   * Fica na persona e nao no ambiente: o Ivan escreve aos gritos curtos e manda
   * mais bolhas, o El Pedrito escreve frases inteiras e manda menos. Uma
   * variavel partilhada obrigava os dois ao mesmo numero.
   */
  maxBubbles: number;

  /**
   * Comprimento acima do qual uma mensagem ainda e comprida de mais para esta
   * persona e vale a pena parti-la por frases.
   */
  maxBubbleChars: number;

  /**
   * Valores e nomes que o MOTOR precisa de dizer ao lead.
   *
   * Nao sao os do prompt — estes aparecem nas regras de fase e na instrucao do
   * link, que sao codigo comum aos dois influencers. Ficam na persona porque o
   * deposito minimo do Ivan nao e o do El Pedrito, e a plataforma tambem nao.
   */
  /**
   * O nome do grupo dele, como o lead o ve.
   *
   * O motor usa-o no prompt do remarketing ("es o X, dono do grupo Y"). Sem isto
   * o Ivan aparecia a dizer que e dono do grupo do El Pedrito.
   */
  groupName: string;
  minDeposit: string;
  suggestedDeposit: string;
  platformName: string;

  /**
   * Aviso legal colado a mensagem que leva o link de afiliado. Vazio, nao se
   * cola nada.
   *
   * Fica na persona, e nao no ambiente, porque e uma decisao editorial de cada
   * influencer: uma variavel partilhada fazia com que desligar o aviso num bot
   * o desligasse no outro.
   */
  complianceNote: string;

  /**
   * Limpeza de estilo propria desta persona, corrida depois do sanitizador
   * comum e antes de o texto ir para o historico.
   *
   * Existe porque ha regras que o modelo esquece a meio da conversa por mais que
   * o prompt insista, e algumas delas sao precisamente as que denunciam texto
   * automatico. Ausente, o texto segue como veio.
   */
  styleGuard?(text: string): string;

  /** Saudacao do primeiro /start. */
  greeting(firstName: string | null): string;

  /**
   * O que dizer quando o redator falha, para o lead nunca ficar no vacuo.
   *
   * Recebe o lead e a mensagem porque a do El Pedrito nao e uma frase fixa: ela
   * muda se o lead esta a voltar e conforme o ponto do funil. E tem de estar aqui
   * por uma razao concreta — a dele fala de "green atras de green" e do grupo VIP,
   * e o Ivan nunca pode dizer isso.
   */
  fallbackReply(lead: Lead, incoming: string): string;

  /**
   * Resposta ao comprovativo de deposito, quando esta persona tiver uma propria.
   *
   * Ausente, quem recebe a imagem responde com o que ja respondia.
   */
  proofAcknowledgement?(firstName: string | null): string;

  /** Resposta a audio, sticker e afins. */
  nonTextNudge: string;

  /**
   * Os guioes de remarketing deste influencer.
   *
   * Tem de estar aqui, e nao no services/remarketing.ts, por uma razao concreta:
   * o agendador corre a campanha de cada persona separadamente, e com um conjunto
   * unico de guioes os leads do Ivan recebiam as mensagens do El Pedrito — com o
   * "green atras de green", com os emigrantes na Suica e com o link dele. Sairia
   * sozinho no primeiro disparo do dia.
   */
  remarketing: {
    /** O que dizer a cada publico, em instrucoes para o redator. */
    briefs: Record<RemarketingAudience, string>;
    /** Texto pronto, para quando o modelo falhar. Escolhido a sorte. */
    fallbacks: Record<RemarketingAudience, string[]>;
    /**
     * Um guiao por toque, para quem nao converteu.
     *
     * A campanha insiste varias vezes e cada toque tem angulo proprio: repetir o
     * mesmo texto e o que faz o lead bloquear. Vazio, usa-se o brief geral.
     */
    toques?: Array<{ brief: string; fallbacks: string[] }>;
    /** Guioes dos botoes de disparo manual do painel. */
    disparos: { nao_qualificado: string[]; qualificado: string[] };
  };
}

/**
 * A proxima pergunta a fazer, desta lista.
 *
 * Fica aqui e nao no motor nem na persona porque as duas pontas precisam dela: a
 * persona, para escrever o bloco de fase, e o funil, para marcar a pergunta como
 * feita no fim do turno. Duas copias da mesma regra acabavam a discordar.
 *
 * Uma pergunta sai da lista por QUALQUER uma das duas vias: ter resposta, ou ter
 * sido feita. Quem nao respondeu a primeira vez nao quer responder, e insistir e
 * o que faz o lead perceber que do outro lado esta uma maquina a preencher
 * campos.
 */
export function proximaPerguntaDe(
  perguntas: PerguntaFunil[],
  lead: LeadComFactos,
): { chave: string; pergunta: string } | null {
  const feitas = new Set(lead.perguntasFeitas ?? []);

  const emFalta = perguntas.filter((p) => {
    if (p.valor) return false;
    if (feitas.has(p.chave)) return false;
    // O nome tem a sua propria marca, anterior a esta lista.
    if (p.chave === 'nome' && lead.nomePerguntado) return false;
    return true;
  });

  const primeira = emFalta[0];
  return primeira ? { chave: primeira.chave, pergunta: primeira.pergunta } : null;
}

/**
 * Link da casa que a diretriz escolheu.
 *
 * Uma escolha desconhecida cai na principal em vez de deixar o lead sem link:
 * perder a conversao por causa de um identificador mal escrito seria pior do
 * que o mandar para a casa errada.
 */
export function resolveHouseLink(persona: Persona, houseId: string): string {
  if (!houseId) return persona.defaultLink;

  const house = persona.houses.find((entry) => entry.id === houseId);
  return house?.link || persona.defaultLink;
}

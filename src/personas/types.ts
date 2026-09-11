import type { RemarketingAudience } from '../db/database';

/** Uma casa por onde o lead se pode registar. */
export interface PersonaHouse {
  /** Identificador que o estrategista devolve em `affiliateHouse`. */
  id: string;
  /** Nome como o lead o ve. */
  label: string;
  link: string;
}

/**
 * Tudo o que muda entre influencers. O motor (funil, fila, ritmo de escrita,
 * sanitizador, remarketing) e comum; so isto varia.
 *
 * Cada persona vive no seu ficheiro e nao conhece as outras: mexer numa nao
 * pode mudar o comportamento de outra que ja esta a converter leads.
 */
export interface Persona {
  id: string;
  agentName: string;

  /** Instrucoes de sistema do estrategista. */
  strategistSystem: string;
  /** Instrucoes de sistema do redator. */
  writerPersona: string;

  /** Saudacao do primeiro /start. */
  greeting(firstName: string | null): string;
  /** Usada quando o redator falha, para o lead nunca ficar no vacuo. */
  fallbackReply(firstName: string | null): string;
  /** Resposta ao comprovativo de deposito. */
  proofAcknowledgement(firstName: string | null): string;
  /** Resposta a audio, sticker e afins. */
  nonTextNudge: string;

  /**
   * Casas disponiveis, a principal primeiro. Vazio significa casa unica, com
   * o link em `defaultLink`.
   */
  houses: PersonaHouse[];
  /** Link usado quando a diretriz nao escolheu casa nenhuma. */
  defaultLink: string;

  /**
   * Comprimento acima do qual uma mensagem ainda e comprida de mais para esta
   * persona e vale a pena parti-la por frases. Registos diferentes toleram
   * comprimentos diferentes: o Ivan escreve aos gritos curtos, o El Pedrito
   * em frases inteiras.
   */
  maxBubbleChars: number;

  /**
   * Limpeza de estilo propria desta persona, corrida depois do sanitizador
   * comum e antes de o texto ir para o historico.
   *
   * Existe porque ha regras que o modelo esquece a meio da conversa por mais
   * que o prompt insista, e algumas delas sao precisamente as que denunciam
   * texto automatico. Ausente, o texto segue como veio.
   */
  styleGuard?(text: string): string;

  remarketing: {
    briefs: Record<RemarketingAudience, string>;
    fallbacks: Record<RemarketingAudience, string[]>;
  };
}

/**
 * Link da casa que a diretriz escolheu. Uma escolha desconhecida cai na
 * principal em vez de deixar o lead sem link: perder a conversao por causa de
 * um identificador mal escrito seria pior do que o mandar para a casa errada.
 */
export function resolveHouseLink(persona: Persona, houseId: string): string {
  if (!houseId) return persona.defaultLink;

  const house = persona.houses.find((entry) => entry.id === houseId);
  return house?.link || persona.defaultLink;
}

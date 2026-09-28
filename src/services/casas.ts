/**
 * Que casa se oferece a este lead, e o que se faz com o que ele disse da conta.
 *
 * Toda a decisao de casa vive aqui, numa funcao pura: sem base de dados, sem
 * env, sem rede. Quem chama le o resultado e age. Assim a tabela de decisao
 * inteira pode ser testada em milissegundos, que e o que uma regra que decide
 * dinheiro merece.
 *
 * PORQUE E QUE ISTO NAO ESTA NO PROMPT. Esteve, e nao funcionou: o prompt do
 * Ivan mandava o modelo escolher a casa num campo `affiliateHouse` que nem
 * sequer existia na diretriz, e o `writer.ts` pedia o link com uma string
 * vazia. Resultado: a casa era SEMPRE a primeira, as outras duas eram codigo
 * morto, e um lead que disse tres vezes que ja tinha conta levou tres vezes o
 * mesmo pedido de deposito. O modelo passa a RELATAR o que o lead disse; quem
 * decide e isto.
 */
import { casaLivre, resolveHouse, type PersonaHouse, type Persona } from '../personas/types';
import { lerClaimDeConta } from '../utils/conta';
import type { Lead } from '../db/database';
import type { SalesDirective } from './strategist';

/**
 * O que fazer neste turno.
 *
 * - `segue` — nada de especial; a casa e a de sempre (ou ainda nenhuma).
 * - `muda` — ele ja tinha conta na que lhe demos; vai para a seguinte.
 * - `confirmar_origem` — ele diz que tem conta e NAO se sabe de quando. E a
 *   pergunta que faltava.
 * - `conta_nova` — ele confirmou que a criou agora. Isto destranca o deposito.
 * - `sem_casas` — nao sobra nenhuma para lhe oferecer. Passa para uma pessoa.
 */
export type EstadoDaCasa =
  | { tipo: 'segue'; casa: PersonaHouse | null }
  | { tipo: 'muda'; casa: PersonaHouse; queimada: PersonaHouse }
  | { tipo: 'confirmar_origem'; casa: PersonaHouse }
  | { tipo: 'conta_nova'; casa: PersonaHouse }
  | {
      tipo: 'sem_casas';
      comConta: string[];
      /**
       * A casa sobre a qual ele ficou por esclarecer, quando foi por ai que se
       * chegou aqui.
       *
       * E o que o operador precisa de ler para pegar na conversa: sem isto o
       * aviso dizia-lhe "nao ha casa configurada", que nem sequer e verdade —
       * ha casa, o que nao ha e resposta.
       */
      emDuvida?: PersonaHouse;
    };

/** A chave com que se marca que a pergunta da origem da conta ja foi feita. */
export const PERGUNTA_ORIGEM = 'conta_origem';

/**
 * Decide o estado da casa para este turno.
 *
 * Devolve null para uma persona de casa unica — o El Pedrito. E o unico
 * interruptor, e e por ele que nada disto lhe toca.
 */
export function decidirCasa(params: {
  persona: Persona;
  lead: Lead;
  incoming: string;
  directive: SalesDirective;
}): EstadoDaCasa | null {
  const { persona, lead, incoming, directive } = params;

  // Casa unica: nada disto se aplica.
  if (persona.houses.length === 0) return null;

  // Defensivo com os campos novos: ha testes que constroem leads parciais, e um
  // lead gravado antes da migracao nao os tem.
  const comConta = lead.casasComConta ?? [];
  const oferecida = resolveHouse(persona, lead.casaOferecida ?? '');
  const jaPerguntouOrigem = (lead.perguntasFeitas ?? []).includes(PERGUNTA_ORIGEM);

  const claim = lerClaimDeConta(incoming);
  const doModelo = directive.contaNaCasa;

  // --- antes de qualquer link ---------------------------------------------
  //
  // Aqui NAO HA AMBIGUIDADE NENHUMA, e e o que torna a porta 1 tao barata: ele
  // nao tem link nenhum nosso, logo qualquer conta de que fale e forcosamente
  // de antes. "Ja tenho conta" dito antes do link so pode querer dizer uma
  // coisa. E por isto que perguntar antes resolve o caso de raiz.
  if (!oferecida) {
    const diz = claim === 'ambiguo' || claim === 'ja_tinha' || doModelo === 'ja_tinha';
    const seguinte = casaLivre(persona, comConta);

    if (diz && seguinte) {
      const proxima = casaLivre(persona, [...comConta, seguinte.id]);
      if (!proxima) return { tipo: 'sem_casas', comConta: [...comConta, seguinte.id] };
      return { tipo: 'muda', casa: proxima, queimada: seguinte };
    }

    if (!seguinte) return { tipo: 'sem_casas', comConta: [...comConta] };
    return { tipo: 'segue', casa: seguinte };
  }

  // --- depois do link ------------------------------------------------------

  // A porta 2 ja foi respondida. Nao se volta a perguntar.
  if (lead.contaConfirmada) return { tipo: 'segue', casa: oferecida };

  // Ele diz que a criou agora.
  //
  // A condicao `claim === null` no ramo do modelo e a regra toda em uma linha:
  // QUANDO O TEXTO E AMBIGUO, NEM O MODELO DESTRANCA O DEPOSITO. Foi
  // exactamente isso que custou o lead — o modelo decidiu tres vezes que o
  // registo estava feito enquanto o lead escrevia "ja tenho conta".
  if (claim === 'criou' || (claim === null && doModelo === 'criou_agora')) {
    return { tipo: 'conta_nova', casa: oferecida };
  }

  // Ele diz que ja a tinha. Muda-se de casa.
  if (claim === 'ja_tinha' || (claim !== 'ambiguo' && doModelo === 'ja_tinha')) {
    const proxima = casaLivre(persona, [...comConta, oferecida.id]);
    if (!proxima) return { tipo: 'sem_casas', comConta: [...comConta, oferecida.id] };
    return { tipo: 'muda', casa: proxima, queimada: oferecida };
  }

  // Ambiguo. Pergunta-se UMA vez.
  if (claim === 'ambiguo') {
    if (!jaPerguntouOrigem) return { tipo: 'confirmar_origem', casa: oferecida };

    // Perguntou-se e ele repetiu a mesma coisa. Uma pessoa resolve isto em dez
    // segundos de leitura; o bot ja deu a volta que tinha a dar.
    return { tipo: 'sem_casas', comConta: [...comConta], emDuvida: oferecida };
  }

  return { tipo: 'segue', casa: oferecida };
}

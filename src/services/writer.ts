import { GoogleGenAI, ThinkingLevel, type Content } from '@google/genai';

import { env } from '../config/env';
import { resolveHouse, resolveHouseLink } from '../personas/types';
import type { Persona } from '../personas/types';
import type { EstadoDaCasa } from './casas';
import type { Lead, StoredMessage } from '../db/database';
import { createLogger } from '../utils/logger';
import { deveCumprimentar, saudacaoAgora } from '../utils/saudacao';
import { sanitiseDashes } from '../utils/text';
import { withRetry } from './retry';
import type { LeadProfile, SalesDirective } from './strategist';

const log = createLogger('writer');

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  cachedClient ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return cachedClient;
}


/**
 * O «MIN_DEPOSIT» e substituido pelo valor da persona na hora de usar o texto.
 *
 * Um marcador e nao a variavel de ambiente porque isto e uma constante de
 * modulo: e lida uma vez, quando o ficheiro carrega, e nessa altura nao se sabe
 * com qual dos influencers se esta a falar.
 */
function orientacaoDePerfil(persona: Persona, perfil: LeadProfile): string {
  // Um perfil que nao esteja na tabela cai no "indefinido" em vez de rebentar
  // ou de escrever "undefined" no prompt — as duas coisas que isto fazia antes,
  // uma delas em silencio. O modelo devolve o perfil num campo do esquema, mas
  // uma diretriz de reserva pode nao o trazer.
  const texto = PROFILE_GUIDANCE[perfil] ?? PROFILE_GUIDANCE.indefinido;
  return texto.replace('«MIN_DEPOSIT»', persona.minDeposit);
}

const PROFILE_GUIDANCE: Record<LeadProfile, string> = {
  indefinido: 'Ainda nao sabes que tipo de lead e. Pergunta, nao empurres.',
  recetivo: 'Ja quer entrar. Vai direto ao passo seguinte, sem enrolar.',
  cetico:
    'Duvida que seja serio. Transparencia acima de argumento: admite que as ' +
    'entradas falham as vezes. Empatia, zero pressao.',
  sem_dinheiro:
    'A objecao e o dinheiro. Deixa claro que entrar no grupo nao custa nada e ' +
    'que os «MIN_DEPOSIT» ficam na conta dele, como saldo dele. Nunca ' +
    'sugiras que arranje dinheiro que nao tem.',
  dificil:
    'Ja resistiu ou respondeu seco. Paciencia e explicacao calma, uma vez. ' +
    'Nao insistas duas vezes seguidas no mesmo ponto.',
};

/**
 * Adiamento nao e recusa: e alguem com horario de trabalho. Insistir aqui
 * transforma um "logo" num "nunca", por isso a regra e explicita e nao fica
 * ao criterio do modelo.
 */
function postponementRule(directive: SalesDirective): string {
  if (!directive.promisedTime) return '';

  return (
    `O lead adiou para as ${directive.promisedTime}. Aceita com calma total — ` +
    'o trabalho e a familia vem primeiro, e dizes isso a serio. Confirma que ' +
    'lhe apitas a essa hora, como um favor que ele te faz e nao como cobranca. ' +
    'NAO insistas, NAO mandes link e NAO faças a mensagem parecer um aviso de ' +
    'cobranca.'
  );
}

/**
 * Interdicao da fase, calculada aqui e nao pedida ao modelo. A sequencia de
 * abordagem e o unico ponto do funil onde uma classificacao errada do
 * estrategista custa o lead na hora: pedir dinheiro a segunda mensagem queima
 * a conversa e nao ha volta. Por isso a regra e determinista.
 *
 * So se aplica enquanto o lead esta no inicio do funil: quem ja disse que se
 * registou nao pode ser impedido de falar do deposito por causa do turno.
 *
 * Exportada por ser a regra mais dificil de verificar so por observacao das
 * respostas — e a mais cara de errar.
 */
export function phaseRule(
  persona: Persona,
  turn: number,
  stage: SalesDirective['stage'],
  /**
   * A decisao da casa deste turno, quando a persona tem casas.
   *
   * Opcional e no fim: quem chama com tres argumentos cai nas fases de sempre.
   */
  casa?: EstadoDaCasa | null,
): string {
  // As fases da casa ganham ao estagio, e tem de ser assim: um lead a dizer
  // que ja tem conta esta a travar o funil, e a regra de fase do estagio
  // mandava-o seguir em frente. Foi essa colisao que custou o lead.
  if (casa?.tipo === 'confirmar_origem') {
    return (
      'FASE — CONFIRMAR A CONTA: ele diz que tem conta, mas nao se sabe se ja a ' +
      'tinha de antes ou se a acabou de criar pelo teu link, e a diferenca decide ' +
      'tudo. Pergunta SO isso, numa pergunta de sim ou nao, e nada mais. PROIBIDO ' +
      'falar de deposito, PROIBIDO mandar link e PROIBIDO dar o registo por feito.'
    );
  }

  if (casa?.tipo === 'muda') {
    return (
      `FASE — MUDAR DE CASA: ele ja tinha conta na ${casa.queimada.label} de antes, ` +
      'e uma conta antiga nao serve. Sem drama e sem o fazer sentir mal: nesse ' +
      `caso e por outra. Manda o link da ${casa.casa.label} e pede-lhe para criar ` +
      'a conta ai. PROIBIDO falar de deposito nesta mensagem e PROIBIDO voltar a ' +
      `mandar o link da ${casa.queimada.label}.`
    );
  }

  const early = stage === 'novo' || stage === 'qualificacao';

  if (early && turn <= 2) {
    return (
      'FASE — RAPPORT: esta mensagem e so conversa. PROIBIDO mencionar registo, ' +
      `deposito, link, valores, bonus ou ${persona.platformName}. Se o lead perguntar ` +
      'quanto custa, diz que ja la vais e faz-lhe uma pergunta sobre ele. ' +
      'Descobre em que e que ele trabalha, que e o que te deixa falar a serio ' +
      'com ele a seguir.'
    );
  }

  if (early && turn === 3) {
    return (
      'FASE — COMUNIDADE E RESULTADOS: apresenta o grupo e o que ele ja fez. ' +
      'AINDA NAO fales de condicao de entrada, deposito ou link.'
    );
  }

  if (early && turn === 4) {
    return (
      'FASE — CONDICAO E PRONTIDAO: explica que entrar e gratuito e o que e ' +
      'preciso, e TERMINA a perguntar se ele esta pronto para abrir a conta e ' +
      'garantir a vaga no VIP. NAO mandes o link nesta mensagem.'
    );
  }

  // A partir daqui o lead ja tem o link. Era o unico momento do funil sem
  // regra de fase nenhuma, e e o momento que decide a venda: metade dos leads
  // chegava a receber o link e nenhum passava dai.
  if (stage === 'registo_enviado') {
    return (
      'FASE — ACOMPANHAR O REGISTO: ele ja tem o link. Pergunta se a pagina ' +
      'ABRIU, nao se ja depositou. Se deu erro, diz-lhe para copiar o link e ' +
      'colar noutro navegador, e nao fales de deposito enquanto isso nao ' +
      'estiver resolvido. Oferece levar o registo com ele, passo a passo, e se ' +
      'ele disser que travou pergunta EM QUE PARTE travou.' +
      // A PORTA 2, e so para quem tem varias casas.
      //
      // Ate aqui esta fase so sabia tratar de um bloqueio tecnico — "a pagina
      // nao abriu" — e nao tinha saida nenhuma para quem esta bloqueado por JA
      // TER conta. E esse o caso que custou o lead do Ivan.
      //
      // Numa persona de casa unica a pergunta nao teria resposta util: ele nao
      // tem para onde ir, e o El Pedrito ja trata o "ja tenho conta noutra
      // casa" com a politica dele, que e a oposta. Por isso a frase so entra
      // quando ha casas, e o prompt do El Pedrito fica byte a byte como estava.
      (persona.houses.length > 0
        ? ' A CONTA TEM DE SER NOVA, criada pelo link que lhe deste: diz-lhe isso ' +
          'e CONFIRMA, com uma pergunta de sim ou nao, se foi agora que a criou ' +
          'pelo teu link. Se ele ja tinha essa conta de antes, isso NAO conta ' +
          'como registo: nao fales de deposito e trata disso com ele.'
        : '')
    );
  }

  if (stage === 'registado') {
    return (
      'FASE — DEPOSITO: ele ja tem conta. Agora sim, o deposito, lembrando que ' +
      'o dinheiro fica na conta dele e sai de la quando quiser. Termina a ' +
      'perguntar se ele quer tratar disso agora.'
    );
  }

  // Depois de aprovado, isto deixa de ser uma venda e passa a ser
  // acompanhamento. Um lead que entra no grupo e nunca mais tem noticias de
  // ninguem sai do grupo na primeira semana.
  if (stage === 'acesso_liberado') {
    return (
      'FASE — ACOMPANHAMENTO: ele JA ESTA DENTRO do grupo e ja pagou. PROIBIDO ' +
      'vender-lhe seja o que for, pedir deposito, mandar links ou falar de ' +
      'condicoes de entrada. O que fazes e perguntar como lhe esta a correr e ' +
      'se ele tem conseguido entrar em TODAS as entradas, que e onde a malta ' +
      'se estraga: seguir metade e apanhar so as que correram mal. Se ele ' +
      'falar em lucro, a ideia e levantar parte e nao deixar tudo em jogo. ' +
      'PROIBIDO mandar recuperar prejuizo com um deposito novo, e PROIBIDO ' +
      'prometer resultado nenhum. Tom de companheiro, mensagem curta, uma ' +
      'pergunta so.'
    );
  }

  if (stage === 'deposito_enviado') {
    return (
      'FASE — PRINT: ele diz que depositou. Pede-lhe o print, com naturalidade, ' +
      'e diz que o acesso sai assim que for validado. NAO confirmes que o ' +
      'acesso ja foi dado.'
    );
  }

  return '';
}

/**
 * O link so sai depois de o lead dizer que sim. A pergunta de prontidao e
 * feita no turno 4, portanto a confirmacao chega no 5 ou depois — e ate la o
 * link fica travado em codigo, mesmo que a diretriz peca o contrario.
 *
 * Mandar o link cedo de mais custa o lead duas vezes: perde-se o
 * micro-compromisso que faz a pessoa avancar, e a conversa passa a parecer o
 * spam de casino que toda a gente ja recebeu.
 */
/**
 * O link vai mesmo sair nesta mensagem?
 *
 * As duas condicoes ja estavam a ser combinadas dentro do
 * `buildDirectiveBlock`, e o `bot.ts` precisa da MESMA resposta para saber se
 * pode dar a casa por oferecida. Duas deducoes separadas da mesma regra e como
 * se desalinham.
 */
export function linkVaiSair(directive: SalesDirective, turn: number): boolean {
  return directive.includeLink && linkAllowed(turn, directive.stage);
}

export function linkAllowed(turn: number, stage: SalesDirective['stage']): boolean {
  const early = stage === 'novo' || stage === 'qualificacao';
  return !early || turn >= 5;
}

/**
 * O que ja se sabe do lead, e portanto o que nunca mais se pergunta.
 *
 * O bloco existe porque a regra "nao repitas perguntas" so por si nao chega:
 * o redator escreve a partir da diretriz, nao do historico completo, e sem
 * esta lista explicita volta a perguntar o que ja foi respondido.
 */
function buildKnownRule(lead: Lead): string {
  const lines: string[] = [];

  if (lead.job) {
    lines.push(
      `O lead trabalha em ${lead.job}. JA TE DISSE ISTO: e PROIBIDO voltar a ` +
        'perguntar em que trabalha, onde trabalha ou que horario faz. Usa-o ' +
        'para falar a serio com ele: os turnos que faz, as horas que lhe ' +
        'sobram, o que lhe rende o dia.',
    );
  }

  if (lead.canton) {
    lines.push(
      `O lead vive em ${lead.canton}. JA TE DISSE ISTO: e PROIBIDO voltar a ` +
        'perguntar onde mora, em que cantao ou em que zona, mesmo por outras ' +
        'palavras.',
    );
  }

  if (lead.bettingExperience) {
    lines.push(
      lead.bettingExperience === 'iniciante'
        ? 'O lead JA TE DISSE que esta a comecar nas apostas. E PROIBIDO voltar ' +
          'a perguntar se ja apostou. Explica com calma, sem termos tecnicos e ' +
          'sem o fazer sentir perdido.'
        : 'O lead JA TE DISSE que ja aposta. E PROIBIDO voltar a perguntar se ja ' +
          'apostou ou se percebe disto. Fala de igual para igual, sem explicar o ' +
          'obvio.',
    );
  }

  if (lead.job && lead.bettingExperience) {
    lines.push(
      'A QUALIFICACAO ACABOU. Nada de perguntas sobre ele: a conversa agora e ' +
        'de parceiro, e o que procuras e a decisao dele sobre entrar no grupo.',
    );
  }

  return lines.join('\n');
}

export function buildDirectiveBlock(
  /**
   * Quem esta a falar. Primeiro argumento de proposito: o link, o aviso legal e
   * o deposito minimo saem dela, e um destes vindo do influencer errado e a
   * mistura a chegar ao lead.
   */
  persona: Persona,
  directive: SalesDirective,
  lead: Lead,
  turn: number,
  incoming: string,
  /**
   * Quando saiu a ultima mensagem desta conversa. Decide o cumprimento: so se
   * cumprimenta no inicio da conversa ou no primeiro contacto de um dia novo.
   */
  ultimaMensagemEm?: string | null,
  /**
   * O que o `decidirCasa` decidiu para este turno, quando ha casas.
   *
   * Opcional e no fim para nao partir quem ja chama esta funcao com cinco ou
   * seis argumentos. Ausente, cai-se no estado guardado no lead.
   */
  casa?: EstadoDaCasa | null,
): string {
  const sendLink = directive.includeLink && linkAllowed(turn, directive.stage);

  // A casa deste turno.
  //
  // Esta linha ja foi `resolveHouseLink(persona, '')` — com a string vazia
  // escrita a mao, o que fazia o `if (!houseId)` disparar sempre e o link ser
  // SEMPRE o da casa principal. As outras duas casas do Ivan eram codigo morto,
  // e um lead que ja tivesse conta na primeira nao tinha para onde ir.
  //
  // Um link errado aqui e uma comissao para outra pessoa; um link da casa onde
  // ele ja esta registado e uma comissao para ninguem.
  const casaDoTurno =
    (casa && 'casa' in casa ? casa.casa : null) ?? resolveHouse(persona, lead.casaOferecida ?? '');
  const link = casaDoTurno?.link || resolveHouseLink(persona, lead.casaOferecida ?? '');

  // O nome da casa acompanha o link, mas SO para quem tem mais do que uma.
  //
  // Sem isto o redator so conhecia o `persona.platformName`, que e fixo na casa
  // principal: a partir da segunda, o Ivan mandava o link do Safe Casino a dizer
  // "regista-te na Plan Bet". Numa persona de casa unica nao ha ambiguidade
  // nenhuma para desfazer, e a frase fica byte a byte como estava — o El
  // Pedrito esta a converter com trafego pago e nao se lhe toca.
  const nomeDaCasa =
    persona.houses.length > 0 ? ` da ${casaDoTurno?.label ?? persona.platformName}` : '';

  // O bonus da casa sai NESTA mensagem e so nesta: e a que diz o deposito
  // minimo. Fica preso ao `sendLink` em codigo, e nao a uma regra no prompt,
  // porque "so falas do bonus quando disseres o minimo" e uma sugestao forte —
  // o modelo cumpre-a quase sempre, e o "quase" e o bonus repetido em cinco
  // mensagens seguidas, que e o que faz aquilo soar a anuncio.
  const bonusRule =
    sendLink && link && persona.bonusClaim ? `\nDiz tambem, em uma frase: ${persona.bonusClaim}.` : '';

  const linkRule =
    sendLink && link
      ? `Inclui o link de registo${nomeDaCasa} exatamente assim: ${link}\n` +
        `Diz tambem: o deposito minimo e ${persona.minDeposit}; para acompanhar todas as ` +
        `entradas do dia sem esgotar a banca o ideal e comecar com ${persona.suggestedDeposit} ` +
        `(conselho teu, nao requisito); e que basta mandares o print do deposito para ` +
        `teres acesso imediato ao VIP.${bonusRule}`
      : 'NAO incluas nenhum link nesta mensagem.';

  // Vazio na persona significa que este influencer nao cola aviso nenhum — e
  // uma decisao editorial de quem opera cada bot, nao uma variavel partilhada.
  const complianceRule = sendLink && persona.complianceNote
    ? `Ao mandar o link, fecha a mensagem com este aviso, em linha separada: "${persona.complianceNote}"`
    : 'Nao e preciso repetir o aviso legal nesta mensagem.';

  // Encerramento curto e sem sermao. Um lead que ouve "o meu conselho sincero e
  // que nao te metas nisto" nao fica agradecido: fica tratado como coitado. Se
  // ha mesmo razao para parar, para-se em duas linhas e sem licoes de vida.
  const stopRule = directive.shouldStop
    ? 'ENCERRAMENTO: no maximo DUAS frases curtas. Diz que assim nao e, que ' +
      'fica para outra altura, e que a porta esta aberta. PROIBIDO dar ' +
      'conselhos de vida, dizer-lhe o que devia fazer primeiro, comentar as ' +
      'escolhas dele, falar em riscos, em prioridades, em orientar a vida ou ' +
      'em ele ficar mais apertado. Nada de sermao e nada de pena. NAO faças ' +
      'nenhuma oferta nem pergunta de vendas.'
    : `PROXIMO PASSO: ${directive.cta}`;

  const phase = phaseRule(persona, turn, directive.stage, casa);
  const postponement = postponementRule(directive);

  const knownRule = buildKnownRule(lead);
  const returning = returningRule(incoming, directive.stage);

  return `[DIRETRIZ INTERNA — NAO MOSTRES AO LEAD]
${deveCumprimentar(ultimaMensagemEm)
  ? `CUMPRIMENTA: e a primeira mensagem da conversa (ou do dia). O cumprimento
certo para a hora da Suica e "${saudacaoAgora()}". Usa esse, nao outro.`
  : `NAO CUMPRIMENTES. A conversa ja vai a meio e ja falaram hoje. PROIBIDO
"bom dia", "boa tarde" ou "boa noite" nesta mensagem. Responde directamente ao
que ele disse.`}
${phase ? `${phase}\n` : ''}${returning}\n${postponement ? `${postponement}\n` : ''}${knownRule ? `${knownRule}\n` : ''}Nome do lead: ${lead.firstName ?? 'desconhecido'}
Estagio do funil: ${directive.stage}
Perfil do lead: ${directive.profile} — ${orientacaoDePerfil(persona, directive.profile)}
Intencao detetada: ${directive.intent}
Objecao a tratar: ${directive.objection}
Interesse (0-100): ${directive.temperature}
Tom pedido: ${directive.tone}
Instrucao: ${directive.directive}
${stopRule}
${linkRule}
${complianceRule}

Escreve agora a proxima mensagem para o lead, em portugues de Portugal.
Apenas o texto da mensagem.`;
}

/**
 * O Gemini exige que a conversa comece com `user`, alterne os papeis e nao
 * tenha turnos vazios; historicos truncados podem comecar pelo atendente.
 * Aqui a janela e normalizada: descarta o prefixo do assistente e funde
 * turnos consecutivos do mesmo lado. O papel do assistente chama-se "model".
 */
function toGeminiContents(history: StoredMessage[]): Content[] {
  const contents: Content[] = [];

  for (const stored of history) {
    const text = stored.content.trim();
    if (text.length === 0) continue;
    if (contents.length === 0 && stored.role !== 'user') continue;

    const role = stored.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];

    if (last && last.role === role && last.parts?.[0]) {
      last.parts[0].text = `${last.parts[0].text ?? ''}\n\n${text}`;
      continue;
    }

    contents.push({ role, parts: [{ text }] });
  }

  return contents;
}

/** Acima disto, um bloco ainda parece um testamento e vale a pena parti-lo. */
const LONG_BUBBLE_CHARS = 200;

/**
 * Parte um texto em frases sem partir URLs. O link de afiliado tem pontos
 * (dominio, extensao, parametros) e um divisor ingenuo cortava-o ao meio —
 * o lead recebia meia ligacao, que nao abre.
 */
function splitSentences(text: string): string[] {
  const urls: string[] = [];
  const masked = text.replace(/https?:\/\/\S+/g, (url) => {
    urls.push(url);
    return `\u0000${urls.length - 1}\u0000`;
  });

  const restore = (part: string) =>
    part.replace(/\u0000(\d+)\u0000/g, (_, index: string) => urls[Number(index)] ?? '');

  return masked
    .split(/(?<=[.!?])\s+/)
    .map((part) => restore(part).trim())
    .filter((part) => part.length > 0);
}

/**
 * Converte a resposta do redator nas mensagens que o lead vai receber.
 *
 * A linha em branco e a separacao que o modelo produz naturalmente, e e o que
 * a persona lhe pede. Mas um modelo que devolva um paragrafo unico nao pode
 * resultar num testamento, por isso os blocos compridos sao partidos por
 * frases — a instrucao de prompt e uma preferencia, esta funcao e a garantia.
 */
export function splitIntoBubbles(
  text: string,
  maxBubbles: number,
  /**
   * Acima deste comprimento vale a pena partir o bloco por frases. Vem da
   * persona: o Ivan escreve aos gritos curtos e o El Pedrito em frases
   * inteiras, e um numero unico para os dois estragava um dos registos.
   */
  maxChars: number = LONG_BUBBLE_CHARS,
): string[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const expanded: string[] = [];

  for (const block of blocks) {
    if (block.length <= maxChars) {
      expanded.push(block);
      continue;
    }

    const sentences = splitSentences(block);
    let buffer = '';

    for (const sentence of sentences) {
      // Junta frases curtas seguidas: uma mensagem com tres palavras nao
      // parece alguem a escrever, parece uma falha.
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;

      if (candidate.length > maxChars && buffer) {
        expanded.push(buffer);
        buffer = sentence;
      } else {
        buffer = candidate;
      }
    }

    if (buffer) expanded.push(buffer);
  }

  if (expanded.length === 0) return [text.trim()].filter((part) => part.length > 0);
  if (expanded.length <= maxBubbles) return expanded;

  // Excedentes vao para a ultima: cortar perderia texto, e o aviso legal e a
  // pergunta final costumam ser as ultimas linhas.
  const kept = expanded.slice(0, maxBubbles - 1);
  kept.push(expanded.slice(maxBubbles - 1).join('\n\n'));
  return kept;
}

/**
 * Orientacao de regresso, so no turno em que ha mesmo um regresso.
 *
 * Vivia no prompt permanente, que vai em todos os turnos, e vazava: o redator
 * dizia "vi que voltaste" a quem estava a meio da primeira conversa e nunca
 * tinha saido. Uma instrucao enfatica que nao se aplica ao turno tinge tudo o
 * resto.
 */
function returningRule(incoming: string, stage: SalesDirective['stage']): string {
  if (!isReturningMarker(incoming)) {
    return (
      'ESTE TURNO NAO E UM REGRESSO: o lead esta a falar contigo agora. E ' +
      'PROIBIDO dizer ou sugerir que ele voltou, reapareceu, desapareceu ou ' +
      'deixou alguma coisa por responder.'
    );
  }

  const base =
    'REGRESSO: o lead carregou em /start e nao escreveu nada. Reconhece-o a ' +
    'tua maneira ("outra vez por aqui, bro?") e retoma onde ficaram. Sem te ' +
    'voltares a apresentar e sem repetir a apresentacao do grupo: ele ja te ' +
    'conhece.';

  if (stage === 'novo' || stage === 'qualificacao') {
    return (
      `${base} Ele ainda nao ouviu a proposta, por isso NAO lhe perguntes se ja ` +
      'decidiu entrar. Retoma a pergunta da fase 1 que ficou por responder, de ' +
      'forma leve.'
    );
  }

  return (
    `${base} Pergunta-lhe a decisao sem rodeios, se ja resolveu entrar ou se vai ` +
    'continuar a adiar, e conta-lhe como o grupo tem andado com as palavras ' +
    '"green atras de green". Com jeito, como quem conta a um amigo, nunca como ' +
    'anuncio. Nao inventes numeros: a expressao descreve a sequencia, e ' +
    'percentagens e valores so os que estiverem na diretriz.'
  );
}

/** Reconhece o marcador de regresso sem depender do texto exacto do bot.ts. */
export function isReturningMarker(incoming: string): boolean {
  return incoming.startsWith('[o lead voltou e carregou em /start');
}

/**
 * Resposta usada quando o redator falha, para o lead nunca ficar no vacuo.
 *
 * O regresso tem texto proprio. Um lead que carrega em /start esta a dar um
 * sinal de interesse, e responder-lhe "deu-me um problema no sistema" desperdica
 * o unico momento em que ele veio ter connosco. Alem disso e a unica forma de
 * garantir o "green atras de green" mesmo quando o Gemini esta em baixo.
 */

/**
 * Etapa 2 da cadeia: o redator recebe a diretriz do estrategista e o
 * historico, e redige a mensagem final que vai para o lead.
 */
export async function writeReply(params: {
  persona: Persona;
  lead: Lead;
  history: StoredMessage[];
  incoming: string;
  directive: SalesDirective;
  /** A decisao da casa deste turno, quando a persona tem casas. */
  casa?: EstadoDaCasa | null;
}): Promise<string> {
  const { persona, lead, history, incoming, directive, casa } = params;

  // Mesma contagem que o estrategista usa, para os dois concordarem sobre em
  // que ponto da sequencia a conversa esta.
  const turn = history.filter((message) => message.role === 'user').length + 1;

  const contents = toGeminiContents([
    ...history,
    {
      id: 0,
      chatId: lead.chatId,
      role: 'user',
      author: 'bot',
      content: incoming,
      mediaFileId: null,
      mediaKind: null,
      directive: null,
      createdAt: new Date().toISOString(),
    },
  ]);

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: incoming }] });
  }

  const startedAt = Date.now();

  const reply = await withRetry({
    attempts: 3,
    log,
    label: 'redator',
    run: async () => {
      const result = await getClient().models.generateContent({
      model: env.GEMINI_WRITER_MODEL,
      contents,
      config: {
          // A persona e fixa; a diretriz muda a cada turno. As duas juntas na
          // instrucao de sistema mantem o historico livre de texto interno, que
          // o lead nunca deve ver ecoado de volta.
          systemInstruction: `${persona.writerPersona}\n\n${buildDirectiveBlock(
            persona,
            directive,
            lead,
            turn,
            incoming,
            history[history.length - 1]?.createdAt,
            casa,
          )}`,
          // O redator nao decide nada: a estrategia ja veio pronta. Pensar aqui
          // so adiciona latencia a uma mensagem de 1-3 frases.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          temperature: 0.9,
          maxOutputTokens: env.GEMINI_WRITER_MAX_TOKENS,
        },
      });

      const usage = result.usageMetadata;

      log.debug(`resposta redigida em ${Date.now() - startedAt}ms`, {
        chatId: lead.chatId,
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        finishReason: result.candidates?.[0]?.finishReason,
      });

      // Limpa aqui, e nao so no envio: a resposta tambem vai para o
      // historico, e um travessao gravado ensina o modelo a repeti-lo no
      // turno seguinte.
      return sanitiseDashes(result.text ?? '');
    },
  });

  return reply && reply.length > 0 ? reply : persona.fallbackReply(lead, incoming);
}

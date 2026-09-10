/**
 * Remove a pontuacao que denuncia texto gerado por IA.
 *
 * O travessao a ligar oracoes ("e gratis — nao pagas nada") e uma marca de
 * escrita de modelo: ninguem o escreve numa mensagem de telemovel, onde se usa
 * virgula, ponto ou uma mensagem nova. O prompt pede que nao apareca, mas o
 * modelo reincide, por isso a limpeza tambem existe em codigo.
 */
export function sanitiseDashes(text: string): string {
  return (
    text
      // Travessao a abrir linha (estilo de dialogo): sai sem deixar virgula.
      .replace(/^[ \t]*[—–][ \t]*/gm, '')
      // Travessao ou meia-risca a ligar ideias, com ou sem espacos a volta.
      // Os espacos sao [ \t] e nao \s de proposito: \s apanharia a linha em
      // branco que separa duas mensagens e fundi-las-ia numa so.
      .replace(/[ \t]*[—–][ \t]*/g, ', ')
      // Hifen isolado no mesmo papel. Exige espaco dos DOIS lados: sem isso
      // partiria "apitas-me", "registares-te" ou "fim-de-semana", que sao
      // portugues correto.
      .replace(/[ \t]+-[ \t]+/g, ', ')
      // A virgula nova pode ter encostado a pontuacao que ja la estava.
      .replace(/([,.!?:;])[ \t]*,[ \t]*/g, '$1 ')
      .replace(/,[ \t]*([.!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .trim()
  );
}

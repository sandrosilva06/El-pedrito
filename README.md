# El Pedrito

Backend autônomo de um funil de vendas no Telegram, construído sobre uma
**arquitetura híbrida de duas IAs em cadeia**:

| Papel | Modelo | Responsabilidade |
| --- | --- | --- |
| **Estrategista** | Gemini (`gemini-3.6-flash`) | Lê o histórico, classifica intenção/objeção/estágio e devolve uma **diretriz de vendas** em JSON. Nunca fala com o lead. |
| **Redator** | Claude (`claude-opus-5`) | Recebe a diretriz e o histórico e escreve a **mensagem final**, informal e persuasiva, que vai para o lead. |

Ambos os modelos são trocáveis por `GEMINI_MODEL` / `ANTHROPIC_MODEL` no `.env`.

O objetivo do funil é levar o lead do primeiro contato até o cadastro e o
primeiro depósito na plataforma de afiliados configurada.

---

## Arquitetura

```
Telegram ──update──▶ grammy ──▶ fila por chat_id
                                     │
                     ┌───────────────┴───────────────┐
                     │                               │
              SQLite (histórico)              Gemini · Estrategista
                     │                               │
                     │                        SalesDirective (JSON)
                     │                               │
                     └──────────────▶ Claude · Redator
                                             │
                                     texto final ──▶ Telegram
                                             │
                                     SQLite (persiste turno + diretriz)
```

Pontos de projeto que valem nota:

- **Fila por `chat_id`.** O Telegram entrega updates em paralelo e o lead
  costuma mandar três mensagens seguidas. Sem serialização, duas cadeias
  Gemini→Claude rodariam sobre o mesmo histórico e as respostas se
  contradiriam.
- **Degradação em vez de queda.** Se o Gemini falhar, uma diretriz
  conservadora assume (pergunta de qualificação, sem link). Se o Claude
  falhar, o lead recebe uma mensagem de "travou aqui" em vez de silêncio.
  Nenhum dos dois serviços lança exceção para cima.
- **Retry no estrategista.** O Gemini devolve `503 high demand` com alguma
  frequência; sem retry isso vira um turno perdido com o lead. São até 3
  tentativas com backoff curto (400ms, 800ms) — curto porque do outro lado
  tem alguém olhando o "digitando...".
- **Sem `temperature` no Claude.** Os modelos atuais removeram os parâmetros
  de sampling e retornam 400 se eles vierem na requisição. A variação de tom
  vem do prompt e da diretriz. `output_config.effort: 'low'` mantém a
  latência curta: quem raciocina é o Gemini, o Claude só redige 1-3 frases.
- **Estágio só avança.** `advanceStage` ignora retrocessos causados por
  classificação ruidosa do Gemini. A única exceção é `perdido`, marcável a
  qualquer momento (opt-out do lead).
- **A diretriz é auditável.** Cada resposta do assistente guarda o JSON da
  diretriz que a gerou, na coluna `messages.directive`.
- **Transação explícita.** `node:sqlite` não tem o helper `transaction()` do
  `better-sqlite3`, então gravar a mensagem e somar o contador do lead corre
  dentro de um `BEGIN`/`COMMIT` próprio — sem isso uma falha no meio deixaria
  os dois fora de sincronia.

### Estágios do funil

`novo → qualificacao → apresentacao → objecao → cadastro_enviado →
cadastrado → deposito_enviado → depositado` (+ `perdido`).

---

## Estrutura

```text
├── src/
│   ├── config/
│   │   └── env.ts            # Validação das variáveis de ambiente (zod)
│   ├── db/
│   │   └── database.ts       # node:sqlite: leads, histórico e estágios
│   ├── services/
│   │   ├── gemini.ts         # Estrategista — gera a diretriz de vendas
│   │   └── claude.ts         # Redator — escreve a mensagem final
│   ├── telegram/
│   │   └── bot.ts            # Handlers, fila, rate limit, comandos
│   ├── utils/
│   │   └── logger.ts         # Logger com níveis
│   └── index.ts              # Servidor Express + bootstrap/shutdown
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Como rodar

```bash
npm install
cp .env.example .env      # preencha as chaves
npm run dev               # long polling, com reload
```

Produção:

```bash
npm run build
npm start
```

### Testar a cadeia sem o Telegram

```bash
npm run chat                       # REPL interativo
npm run chat -- "me manda o link"  # turnos roteirizados
```

Imprime a diretriz do estrategista antes da resposta do redator, que é o que
interessa ao calibrar os prompts. Usa um SQLite separado
(`./data/chat-harness.sqlite`) para não sujar o banco do bot.

Requer **Node.js 22.5+** — a persistência usa `node:sqlite`, o SQLite embutido
no runtime. O projeto **não tem nenhuma dependência nativa**: `npm ci` não
dispara `node-gyp` nem compila C++, então o build funciona em qualquer
plataforma sem toolchain (Render, Railway, Fly, containers slim).

### Variáveis obrigatórias

`TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`. O boot falha com
uma lista explícita do que está faltando — não há default silencioso para
credencial. Todas as demais estão documentadas no `.env.example`.

Ajuste também os campos de negócio (`PLATFORM_NAME`, `AFFILIATE_LINK`,
`CURRENT_OFFER`, `MIN_DEPOSIT`, `AGENT_NAME`), que são injetados nos prompts
das duas IAs.

---

## Polling x Webhook

**O modo é decidido sozinho.** Havendo URL pública — `TELEGRAM_WEBHOOK_URL`, ou
`RENDER_EXTERNAL_URL` que o Render injeta — o boot usa webhook e o registra no
Telegram. Sem ela, usa long polling. `TELEGRAM_MODE` só existe para forçar um
dos dois.

O motivo do automático: um serviço web alcançável pela internet deve receber
webhook. Em polling numa plataforma que hiberna por inatividade, o serviço
dorme, ninguém faz polling, e nada volta a acordá-lo — o bot fica mudo até o
próximo deploy, sem erro em lugar nenhum.

`TELEGRAM_WEBHOOK_SECRET` é opcional: sem ele, um valor estável é derivado do
token do bot. Exigir a variável faria o boot falhar em quem só configurou a
URL, e um deploy que não sobe ajuda menos que um segredo derivado.

A rota registrada no Telegram é derivada do token
(`/telegram/<cauda-do-token>`), mas `/webhook` também é aceito — é o caminho
que se digita ao apontar o webhook à mão, e um POST no caminho errado daria
404 sem nenhuma pista. Ambos exigem o header
`X-Telegram-Bot-Api-Secret-Token`; sem ele, `401`.

### Quando o bot não responde

`GET /health` mostra o que o Telegram acha do webhook, sem precisar dos logs:

```json
{
  "status": "ok",
  "telegram": {
    "mode": "webhook",
    "botUsername": "seu_bot",
    "webhookRegistered": true,
    "pendingUpdates": 0,
    "lastError": null,
    "error": null
  }
}
```

`webhookRegistered: false` significa que o Telegram tem outra URL registrada.
`lastError` traz a última falha de entrega (certificado, 5xx, timeout).
`pendingUpdates` alto indica updates represados sem serem entregues.
`error` preenchido (com `status: "degraded"`) significa que a conexão com o
Telegram falhou no boot — o servidor sobe mesmo assim, para o `/health` poder
contar o motivo.

### Rotas HTTP

| Rota | Descrição |
| --- | --- |
| `GET /health` | Estado do registro no Telegram, uptime e o último erro de entrega. |
| `GET /stats` | Métricas do funil. Exige `x-admin-token` com o `TELEGRAM_WEBHOOK_SECRET` **configurado à mão**; com segredo derivado o endpoint fica desligado (`404`). |
| `POST /telegram/<cauda-do-token>` | Webhook do Telegram. |
| `POST /webhook` | Mesmo handler, para webhook apontado à mão. |

---

## Comandos do bot

| Comando | Efeito |
| --- | --- |
| `/start` | Abre o funil e move o lead para `qualificacao`. |
| `/reset` | Limpa o histórico e as anotações, mantendo o lead. |
| `/parar` | Opt-out: apaga o lead e todo o histórico. |
| `/stats` | Métricas do funil. Restrito aos `ADMIN_CHAT_IDS`; ignorado silenciosamente para os demais. |

---

## Limites embutidos nos prompts

Os dois prompts (estrategista e redator) carregam as mesmas restrições, para
que a diretriz não possa pedir o que o redator não pode escrever:

- nada de promessa de lucro garantido, "dinheiro fácil" ou valores de retorno;
- nada de números, prints, depoimentos, prazos ou vagas inventados;
- nunca pedir senha, código de verificação, cartão ou documentos;
- encerrar sem insistir quando o lead menciona dívida, vício, desespero
  financeiro ou idade abaixo de `MIN_AGE`;
- o link só sai quando o lead demonstra interesse concreto, e sempre
  acompanhado do `COMPLIANCE_NOTE`;
- se o lead perguntar diretamente se está falando com um bot, o redator
  assume que é um atendimento automatizado — a persona é informal, não é
  um disfarce.

Ajuste `COMPLIANCE_NOTE` e `MIN_AGE` conforme a regulação do seu mercado e as
regras do programa de afiliados que você divulga.

---

## Deploy

O build não exige toolchain nativa, então qualquer plataforma Node serve:

```
Build command:  npm ci && npm run build
Start command:  npm start
```

Configure as variáveis do `.env.example` no painel da plataforma. No Render
não é preciso definir `TELEGRAM_MODE` nem `TELEGRAM_WEBHOOK_URL`: a URL
pública vem de `RENDER_EXTERNAL_URL` e o modo webhook é escolhido a partir
dela.

A porta HTTP sobe antes de qualquer chamada ao Telegram. As plataformas
derrubam o serviço que não liga a porta dentro de um prazo, e falar com o
Telegram primeiro significava que um token errado ou uma latência alta viravam
deploy falho em vez de erro diagnosticável.

**Atenção ao disco.** O `node:sqlite` grava num arquivo, e a maioria das
plataformas (Render incluído) tem sistema de arquivos efêmero: sem um disco
persistente montado, o banco é recriado a cada deploy e a cada restart, e a
memória de todos os leads se perde. Monte um disco persistente e aponte
`DATABASE_PATH` para dentro dele (ex.: `/var/data/funnel.sqlite`), ou troque a
persistência por um banco gerenciado. O esquema está isolado em
`src/db/database.ts` — só esse arquivo muda.

`node:sqlite` ainda é marcado como experimental no Node 22 (ele emite um aviso
no boot) e estável no Node 24. A API usada aqui — `DatabaseSync`, `prepare`,
`run`/`get`/`all`, `exec` — não mudou entre as duas versões.

## Privacidade

O banco guarda conteúdo de conversas privadas: `chat_id`, nome, username e
todas as mensagens. Trate o arquivo como dado pessoal — ele fica fora do git
(`data/` está no `.gitignore`), deve ficar em volume com backup controlado, e
`/parar` existe para atender pedidos de exclusão.

# El Pedrito

Backend autônomo de um funil de vendas no Telegram, construído sobre uma
**arquitetura híbrida de duas IAs em cadeia**:

| Papel | Modelo | Responsabilidade |
| --- | --- | --- |
| **Estrategista** | Gemini | Lê o histórico, classifica intenção/objeção/estágio e devolve uma **diretriz de vendas** em JSON. Nunca fala com o lead. |
| **Redator** | Claude | Recebe a diretriz e o histórico e escreve a **mensagem final**, informal e persuasiva, que vai para o lead. |

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
- **Estágio só avança.** `advanceStage` ignora retrocessos causados por
  classificação ruidosa do Gemini. A única exceção é `perdido`, marcável a
  qualquer momento (opt-out do lead).
- **A diretriz é auditável.** Cada resposta do assistente guarda o JSON da
  diretriz que a gerou, na coluna `messages.directive`.

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
│   │   └── database.ts       # SQLite: leads, histórico e estágios
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

Requer Node.js 20+ (`better-sqlite3` compila um binding nativo na instalação).

### Variáveis obrigatórias

`TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`. O boot falha com
uma lista explícita do que está faltando — não há default silencioso para
credencial. Todas as demais estão documentadas no `.env.example`.

Ajuste também os campos de negócio (`PLATFORM_NAME`, `AFFILIATE_LINK`,
`CURRENT_OFFER`, `MIN_DEPOSIT`, `AGENT_NAME`), que são injetados nos prompts
das duas IAs.

---

## Polling x Webhook

`TELEGRAM_MODE=polling` (padrão) é o modo de desenvolvimento: não exige URL
pública e o `deleteWebhook` é chamado no boot.

`TELEGRAM_MODE=webhook` é o modo de produção e exige:

- `TELEGRAM_WEBHOOK_URL` — URL HTTPS pública, sem barra final;
- `TELEGRAM_WEBHOOK_SECRET` — 16+ caracteres (`openssl rand -hex 32`).

A rota não é `/webhook`: ela é derivada do token (`/telegram/<cauda-do-token>`)
e só aceita requisições com o header `X-Telegram-Bot-Api-Secret-Token` correto —
qualquer outra recebe `401`. O webhook é registrado automaticamente no boot.

### Rotas HTTP

| Rota | Descrição |
| --- | --- |
| `GET /health` | Liveness probe: status, modo e uptime. |
| `GET /stats` | Métricas do funil. Exige o header `x-admin-token` com o valor de `TELEGRAM_WEBHOOK_SECRET`; sem ele responde `404`. |
| `POST /telegram/<cauda-do-token>` | Webhook do Telegram (só em modo webhook). |

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

## Privacidade

O SQLite guarda conteúdo de conversas privadas: `chat_id`, nome, username e
todas as mensagens. Trate o arquivo como dado pessoal — ele fica fora do git
(`data/` está no `.gitignore`), deve ficar em volume com backup controlado, e
`/parar` existe para atender pedidos de exclusão.

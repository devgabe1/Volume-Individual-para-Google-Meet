# Publicar na Chrome Web Store

## 1. Conta de desenvolvedor (uma vez)

1. Acesse o [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Entre com a conta Google que vai aparecer como publicadora.
3. Pague a taxa única de registro (US$ 5) e aceite o contrato.
4. Confirme o e-mail de contato. Ele é obrigatório para publicar.

> Dica: se quiser separar da sua conta pessoal, crie um "grupo de publicação" ou
> uma conta Google só para isso antes de pagar.

## 2. Preparar o pacote

1. Atualize `version` em [`extension/manifest.json`](../extension/manifest.json).
   Cada envio precisa de uma versão maior que a anterior.
2. Gere o zip:
   ```bash
   powershell -ExecutionPolicy Bypass -File scripts/pack.ps1
   ```
3. Teste o zip: em `chrome://extensions`, remova a versão de desenvolvimento,
   extraia o zip numa pasta, carregue com **Carregar sem compactação** e faça uma
   chamada de teste.

## 3. Imagens da página da loja

| Item | Tamanho | Obrigatório |
|---|---|---|
| Ícone | 128×128 (já em `extension/icons/icon128.png`) | Sim |
| Capturas de tela | 1280×800 ou 640×400, de 1 a 5 | Sim (pelo menos 1) |
| Bloco promocional pequeno | 440×280 (já em `store/promo-440x280.png`; gere de novo com `python scripts/build-store-images.py`) | Sim |
| Bloco promocional de letreiro (marquee) | 1400×560 (já em `store/promo-1400x560.png`) | Não |

Sugestões de capturas:
1. Painel aberto durante uma chamada, com várias pessoas e volumes diferentes.
2. Controle aparecendo ao passar o mouse sobre o vídeo de alguém.
3. Página de opções com pessoas salvas.

> Borre ou use nomes fictícios nas capturas: não publique rostos e nomes de
> pessoas reais sem autorização.

## 4. Preencher o item no painel

**Item → Novo item → envie o zip.** Depois, preencha as abas abaixo.

### Ficha da loja

- **Nome:** Volume Individual para Google Meet
- **Resumo** (até 132 caracteres):
  > Ajuste o volume de cada participante do Google Meet separadamente, como no Discord.
- **Descrição** (copie o bloco inteiro):

  ```text
  Alguém fala muito alto e outra pessoa quase não dá para ouvir? Com o Volume Individual você ajusta o volume de cada participante do Google Meet separadamente, de 0% a 200%, ou silencia só uma pessoa — como no Discord.

  RECURSOS
  • Volume por pessoa, direto no vídeo (passe o mouse) ou no painel
  • Nomes identificados automaticamente pelo indicador de fala do Meet
  • Volumes lembrados entre chamadas
  • Opção "Igualar volumes": aproxima quem fala alto de quem fala baixo e evita som estourado
  • Painel arrastável, que se esconde quando um menu do Meet abre
  • Página de opções para revisar e apagar os volumes salvos

  COMO USAR
  1. Entre numa chamada do Google Meet.
  2. Clique no botão de volume na barra de controles, ao lado do microfone, ou passe o mouse sobre o vídeo de alguém.
  3. Ajuste o volume da pessoa. Pronto: ele fica salvo para as próximas chamadas.

  PRIVACIDADE
  Tudo acontece no seu navegador. O áudio é processado localmente e nunca é gravado nem enviado. Sem contas, sem servidores, sem anúncios e sem rastreamento.

  Código aberto: https://github.com/devgabe1/Volume-Individual-para-Google-Meet

  Esta extensão não é afiliada ao Google. Google Meet é marca do Google LLC.
  ```
- **Categoria:** Comunicação (ou Produtividade)
- **Idioma:** Português (Brasil)

### Campos extras

| Campo | O que colocar |
|---|---|
| URL oficial | **Nenhum** (só serve para sites verificados no Google Search Console) |
| URL da página inicial | `https://github.com/devgabe1/Volume-Individual-para-Google-Meet` |
| URL do suporte | `https://github.com/devgabe1/Volume-Individual-para-Google-Meet/issues` |
| Conteúdo adulto | Desligado |
| Suporte para itens | Opcional: ativa uma aba de suporte na página da loja. Com a URL de suporte preenchida, pode deixar desativado. |

### Privacidade

- **Finalidade única:**
  > Permitir que o usuário ajuste o volume de cada participante individualmente
  > nas chamadas do Google Meet.
- **Justificativa da permissão `storage`:**
  > Guardar localmente o volume escolhido para cada participante e as preferências
  > da extensão, para que sejam lembrados entre chamadas.
- **Justificativa do acesso ao host `meet.google.com`:**
  > A extensão precisa rodar nas páginas do Google Meet para processar o áudio da
  > chamada localmente (ajuste de volume) e exibir o painel de controle.
- **Código remoto:** Não. Todo o código está no pacote.
- **Uso de dados:** não marque nenhuma categoria de coleta. O processamento é
  local e nada é transmitido. Marque as três declarações de conformidade.
- **URL da política de privacidade:**
  `https://github.com/devgabe1/Volume-Individual-para-Google-Meet/blob/main/PRIVACY.md`
  (o repositório precisa estar público).

### Distribuição

- **Visibilidade:** comece com **Não listado** para testar com amigos pelo link. Depois mude para **Público**.
- **Regiões:** todas.

## 5. Enviar para revisão

Clique em **Enviar para revisão**. A revisão costuma levar de alguns dias a algumas
semanas. Extensões que interceptam áudio ou rodam no "MAIN world" podem passar por
revisão mais detalhada. As justificativas acima ajudam.

Motivos comuns de rejeição e como evitá-los:

- **Permissões sem justificativa:** preencha todas.
- **Descrição vaga ou com palavras-chave em excesso:** mantenha o texto acima.
- **Uso indevido de marca:** não use o logo do Meet e deixe claro que não há afiliação ao Google.
- **Funcionalidade que não dá para testar:** nas notas para o revisor, explique que é
  preciso uma chamada do Meet com pelo menos 2 participantes.

## 6. Atualizações

1. Aumente `version` no `manifest.json` (por exemplo, `1.0.0` → `1.0.1`).
2. Rode `scripts/pack.ps1`.
3. No painel: **Pacote → Enviar novo pacote → Enviar para revisão**.

Os usuários recebem a atualização automaticamente depois da aprovação.

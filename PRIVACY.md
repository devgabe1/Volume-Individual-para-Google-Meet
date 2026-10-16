# Política de privacidade

_Última atualização: 16 de outubro de 2026_

A extensão **Volume Individual para Google Meet** não coleta, transmite, vende ou
compartilha dados pessoais.

## O que é processado

- **Áudio da chamada**: é processado localmente, em tempo real, só para ajustar o
  volume. Nada é gravado nem enviado para lugar nenhum.
- **Nomes dos participantes**: são lidos da tela do Meet para identificar quem
  está falando.

## O que é armazenado

Ficam salvos no `chrome.storage.local`, apenas no seu navegador:

- o volume e o estado de silenciado de cada pessoa, associados ao nome dela;
- as preferências da extensão (volume geral, "igualar volumes", nomes automáticos,
  botão na barra do Meet);
- a posição do botão flutuante.

Esses dados nunca saem do seu computador. Você pode apagá-los a qualquer momento
na página de opções da extensão ou removendo a extensão.

## Diagnóstico (opcional)

O painel tem um botão **"Gravar diagnóstico"**. Ele só funciona quando você clica
nele: grava por 15 segundos dados técnicos da chamada (níveis de áudio, como o Meet
organiza os canais de som e a barra de controles) e **baixa um arquivo no seu
computador**. Os nomes dos participantes são trocados por apelidos (Pessoa1,
Pessoa2...). O arquivo não é enviado a lugar nenhum — ele só chega a alguém se você
mesmo decidir compartilhá-lo, por exemplo para relatar um problema.

## Permissões

| Permissão | Por quê |
|---|---|
| `storage` | Guardar volumes e preferências no seu navegador. |
| Acesso a `meet.google.com` | Ajustar o áudio e mostrar o painel nas chamadas do Meet. |

## Terceiros

A extensão não usa servidores próprios, analytics, anúncios nem bibliotecas de
terceiros.

## Contato

Dúvidas: abra uma [issue no GitHub](https://github.com/devgabe1/Volume-Individual-para-Google-Meet/issues).

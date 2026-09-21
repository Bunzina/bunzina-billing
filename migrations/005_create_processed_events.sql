-- Idempotência no consumo. O consumer grava aqui NA MESMA TRANSAÇÃO da escrita
-- de negócio; violação de chave primária significa mensagem já processada, e o
-- consumer faz ack sem efeito.
--
-- Sem isso, um redelivery do RabbitMQ aplica o mesmo efeito duas vezes.
CREATE TABLE IF NOT EXISTS bunzina.processed_events (
  event_id   UUID        NOT NULL,
  consumer   TEXT        NOT NULL,
  handled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, consumer)
);

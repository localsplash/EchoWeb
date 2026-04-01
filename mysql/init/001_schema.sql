CREATE DATABASE IF NOT EXISTS echo_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE echo_db;

CREATE TABLE IF NOT EXISTS sms_lkp_MessageEvent (
  eMessageEventTypeID INT PRIMARY KEY,
  messageEvent VARCHAR(32) NOT NULL,
  description VARCHAR(255)
) ENGINE=InnoDB;

INSERT INTO sms_lkp_MessageEvent (eMessageEventTypeID, messageEvent, description) VALUES
(1, 'message-received', 'Inbound from customer'),
(2, 'message-sending', 'Outbound initiated'),
(4, 'message-delivered', 'Outbound successful'),
(8, 'message-failed', 'Outbound error')
ON DUPLICATE KEY UPDATE
  messageEvent = VALUES(messageEvent),
  description = VALUES(description);

CREATE TABLE IF NOT EXISTS sms_tbl_Message (
  iMessageId BIGINT AUTO_INCREMENT PRIMARY KEY,
  sMessageId VARCHAR(64) CHARACTER SET latin1 COLLATE latin1_general_cs NOT NULL,
  bInbound BOOLEAN NOT NULL DEFAULT 0,
  iBusinessNumber BIGINT NOT NULL,
  iCustomerNumber BIGINT NOT NULL,
  text TEXT,
  dtCreated DATETIME(3) NOT NULL,
  eMessageEventTypeID INT NOT NULL,
  bIsRead BOOLEAN NOT NULL DEFAULT 0,
  UNIQUE INDEX idx_messageId (sMessageId),
  INDEX idx_customer (iCustomerNumber),
  CONSTRAINT fk_message_event_type FOREIGN KEY (eMessageEventTypeID) REFERENCES sms_lkp_MessageEvent(eMessageEventTypeID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sms_tbl_MessageEvent (
  iEventId BIGINT AUTO_INCREMENT PRIMARY KEY,
  iMessageId BIGINT NOT NULL,
  eMessageEventTypeID INT NOT NULL,
  dtEvent DATETIME(3) NOT NULL,
  iErrorCode INT,
  description TEXT,
  CONSTRAINT fk_msg_id FOREIGN KEY (iMessageId) REFERENCES sms_tbl_Message(iMessageId),
  CONSTRAINT fk_event_id FOREIGN KEY (eMessageEventTypeID) REFERENCES sms_lkp_MessageEvent(eMessageEventTypeID),
  UNIQUE INDEX idx_msg_event (iMessageId, eMessageEventTypeID)
) ENGINE=InnoDB;

DELIMITER $$

DROP PROCEDURE IF EXISTS sms_usp_Message_INS$$
CREATE PROCEDURE sms_usp_Message_INS(
  IN p_sMessageId VARCHAR(64),
  IN p_bInbound BOOLEAN,
  IN p_iBusinessNumber BIGINT,
  IN p_iCustomerNumber BIGINT,
  IN p_text TEXT,
  IN p_dtCreated DATETIME(3),
  IN p_eMessageEventTypeID INT
)
BEGIN
  INSERT INTO sms_tbl_Message (
    sMessageId, bInbound, iBusinessNumber, iCustomerNumber, text, dtCreated, eMessageEventTypeID
  ) VALUES (
    p_sMessageId, p_bInbound, p_iBusinessNumber, p_iCustomerNumber, p_text, p_dtCreated, p_eMessageEventTypeID
  )
  ON DUPLICATE KEY UPDATE
    iBusinessNumber = VALUES(iBusinessNumber),
    iCustomerNumber = VALUES(iCustomerNumber),
    text = COALESCE(VALUES(text), text),
    eMessageEventTypeID = VALUES(eMessageEventTypeID);

  SELECT iMessageId FROM sms_tbl_Message WHERE sMessageId = p_sMessageId LIMIT 1;
END$$

DROP PROCEDURE IF EXISTS sms_usp_MessageEvent_SET$$
CREATE PROCEDURE sms_usp_MessageEvent_SET(
  IN p_sMessageId VARCHAR(64),
  IN p_eMessageEventTypeID INT,
  IN p_dtEvent DATETIME(3),
  IN p_iErrorCode INT,
  IN p_description TEXT
)
BEGIN
  DECLARE v_iMessageId BIGINT;

  SELECT iMessageId INTO v_iMessageId
  FROM sms_tbl_Message
  WHERE sMessageId = p_sMessageId
  LIMIT 1;

  IF v_iMessageId IS NULL THEN
    SELECT 0 AS updated;
  ELSE
    INSERT INTO sms_tbl_MessageEvent (
      iMessageId, eMessageEventTypeID, dtEvent, iErrorCode, description
    ) VALUES (
      v_iMessageId, p_eMessageEventTypeID, p_dtEvent, p_iErrorCode, p_description
    )
    ON DUPLICATE KEY UPDATE
      dtEvent = VALUES(dtEvent),
      iErrorCode = VALUES(iErrorCode),
      description = VALUES(description);

    UPDATE sms_tbl_Message
    SET eMessageEventTypeID = p_eMessageEventTypeID
    WHERE iMessageId = v_iMessageId;

    SELECT 1 AS updated;
  END IF;
END$$

DROP PROCEDURE IF EXISTS sms_usp_MessageRead_SET$$
CREATE PROCEDURE sms_usp_MessageRead_SET(
  IN p_iMessageID BIGINT,
  IN p_bIsRead BOOLEAN
)
BEGIN
  UPDATE sms_tbl_Message
  SET bIsRead = p_bIsRead
  WHERE iMessageId = p_iMessageID;
END$$

DROP PROCEDURE IF EXISTS sms_usp_Message_GET$$
CREATE PROCEDURE sms_usp_Message_GET(
  IN p_iBusinessNumber BIGINT
)
BEGIN
  SELECT
    m.iMessageId,
    m.sMessageId,
    m.bInbound,
    m.iBusinessNumber,
    m.iCustomerNumber,
    m.text,
    m.dtCreated,
    m.eMessageEventTypeID,
    l.messageEvent,
    m.bIsRead
  FROM sms_tbl_Message m
  INNER JOIN sms_lkp_MessageEvent l ON l.eMessageEventTypeID = m.eMessageEventTypeID
  WHERE m.iBusinessNumber = p_iBusinessNumber
  ORDER BY m.dtCreated DESC;
END$$

DROP PROCEDURE IF EXISTS sms_usp_MessageReadLatest_SET$$
CREATE PROCEDURE sms_usp_MessageReadLatest_SET(
  IN p_iBusinessNumber BIGINT,
  IN p_iCustomerNumber BIGINT,
  IN p_bIsRead BOOLEAN
)
BEGIN
  UPDATE sms_tbl_Message
  SET bIsRead = p_bIsRead
  WHERE iMessageId = (
    SELECT iMessageId FROM (
      SELECT iMessageId
      FROM sms_tbl_Message
      WHERE iBusinessNumber = p_iBusinessNumber
        AND iCustomerNumber = p_iCustomerNumber
      ORDER BY dtCreated DESC, iMessageId DESC
      LIMIT 1
    ) x
  );
END$$

DROP PROCEDURE IF EXISTS sms_usp_Message_DEL$$
CREATE PROCEDURE sms_usp_Message_DEL(
  IN p_iMessageID BIGINT
)
BEGIN
  DELETE FROM sms_tbl_MessageEvent WHERE iMessageId = p_iMessageID;
  DELETE FROM sms_tbl_Message WHERE iMessageId = p_iMessageID;
END$$

DROP PROCEDURE IF EXISTS sms_usp_Customer_DEL$$
CREATE PROCEDURE sms_usp_Customer_DEL(
  IN p_iBusinessNumber BIGINT,
  IN p_iCustomerNumber BIGINT
)
BEGIN
  DELETE e FROM sms_tbl_MessageEvent e
  INNER JOIN sms_tbl_Message m ON m.iMessageId = e.iMessageId
  WHERE m.iBusinessNumber = p_iBusinessNumber
    AND m.iCustomerNumber = p_iCustomerNumber;

  DELETE FROM sms_tbl_Message
  WHERE iBusinessNumber = p_iBusinessNumber
    AND iCustomerNumber = p_iCustomerNumber;
END$$

DELIMITER ;

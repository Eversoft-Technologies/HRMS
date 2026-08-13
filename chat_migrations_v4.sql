-- =============================================================================
-- HRMS — Employee Chat: pinned messages + replies
-- Adds columns to `chat_messages`. Safe to re-run.
--   mysql -u root -p hrms_system < chat_migrations_v4.sql
-- =============================================================================

DROP PROCEDURE IF EXISTS hrms_add_col;
DELIMITER $$
CREATE PROCEDURE hrms_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN ', ddl);
    PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

CALL hrms_add_col('chat_messages', 'is_pinned',       '`is_pinned` TINYINT(1) NOT NULL DEFAULT 0');
CALL hrms_add_col('chat_messages', 'reply_to_id',     '`reply_to_id` INT NULL');
CALL hrms_add_col('chat_messages', 'reply_to_sender', '`reply_to_sender` VARCHAR(255) NULL');
CALL hrms_add_col('chat_messages', 'reply_to_text',   '`reply_to_text` VARCHAR(500) NULL');

DROP PROCEDURE IF EXISTS hrms_add_col;
-- Done. Restart Django afterwards.
-- =============================================================================

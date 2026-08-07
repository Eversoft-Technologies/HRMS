-- =============================================================================
-- HRMS — Employee Chat: message editing, deleting, and file sharing
-- Adds new columns to `chat_messages`. Safe to re-run — each column is only
-- added if it doesn't already exist (works on MySQL 5.7/8 and MariaDB).
--
--   mysql -u root -p hrms_system < chat_migrations_v2.sql
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

CALL hrms_add_col('chat_messages', 'edited',          '`edited` TINYINT(1) NOT NULL DEFAULT 0');
CALL hrms_add_col('chat_messages', 'edited_at',       '`edited_at` DATETIME NULL');
CALL hrms_add_col('chat_messages', 'is_deleted',      '`is_deleted` TINYINT(1) NOT NULL DEFAULT 0');
CALL hrms_add_col('chat_messages', 'attachment_name', '`attachment_name` VARCHAR(255) NULL');
CALL hrms_add_col('chat_messages', 'attachment_type', '`attachment_type` VARCHAR(100) NULL');
CALL hrms_add_col('chat_messages', 'attachment_data', '`attachment_data` LONGTEXT NULL');

DROP PROCEDURE IF EXISTS hrms_add_col;

-- Done. Restart Django so the updated model/endpoints load.
-- =============================================================================

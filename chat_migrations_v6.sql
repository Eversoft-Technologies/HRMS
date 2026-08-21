-- =============================================================================
-- HRMS — Employee Chat: per-member read receipts (channel "Seen by all")
-- Adds `last_read_at` to `chat_members`. Idempotent — safe to re-run.
--   mysql -u root -p hrms_system < chat_migrations_v6.sql
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
CALL hrms_add_col('chat_members', 'last_read_at', '`last_read_at` DATETIME NULL');
DROP PROCEDURE IF EXISTS hrms_add_col;

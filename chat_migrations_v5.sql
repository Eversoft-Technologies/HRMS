-- =============================================================================
-- HRMS — Employee Chat: pin metadata (30-day expiry + pinned_by ownership)
-- Adds columns to `chat_messages`. Idempotent — safe to re-run.
--   mysql -u root -p hrms_system < chat_migrations_v5.sql
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

CALL hrms_add_col('chat_messages', 'pinned_by',      '`pinned_by` VARCHAR(255) NULL');
CALL hrms_add_col('chat_messages', 'pinned_at',      '`pinned_at` DATETIME NULL');
CALL hrms_add_col('chat_messages', 'pin_expires_at', '`pin_expires_at` DATETIME NULL');

DROP PROCEDURE IF EXISTS hrms_add_col;
-- Done. Restart Django afterwards.
-- =============================================================================

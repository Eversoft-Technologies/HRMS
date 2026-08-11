-- =============================================================================
-- HRMS — Employee Chat: channel admins/members + on-disk attachments
-- Adds columns and backfills existing channel creators as admins.
-- Safe to re-run (columns added only if missing).
--
--   mysql -u root -p hrms_system < chat_migrations_v3.sql
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

-- Channel admin flag on membership.
CALL hrms_add_col('chat_members',  'is_admin',        '`is_admin` TINYINT(1) NOT NULL DEFAULT 0');
-- On-disk attachment reference.
CALL hrms_add_col('chat_messages', 'attachment_path', '`attachment_path` VARCHAR(512) NULL');

DROP PROCEDURE IF EXISTS hrms_add_col;

-- Backfill: make each room's creator an admin of that room (if they're a member).
UPDATE `chat_members` m
JOIN `chat_rooms` r ON m.room_id = r.id
SET m.is_admin = 1
WHERE m.employee_email = r.created_by;

-- Safety net: any group room left with no admin gets its earliest member promoted.
UPDATE `chat_members` cm
JOIN (
  SELECT mm.room_id, MIN(mm.id) AS first_id
  FROM `chat_members` mm
  JOIN `chat_rooms` rr ON rr.id = mm.room_id AND rr.is_group = 1
  WHERE mm.room_id NOT IN (SELECT room_id FROM `chat_members` WHERE is_admin = 1)
  GROUP BY mm.room_id
) x ON cm.id = x.first_id
SET cm.is_admin = 1;

-- Done. Restart Django afterwards.
-- =============================================================================

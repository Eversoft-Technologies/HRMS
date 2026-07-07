-- =============================================================================
-- HRMS — Advanced Attendance Management System
-- Run against `hrms_ai` database BEFORE restarting Django.
-- All statements use IF NOT EXISTS so safe to re-run.
-- =============================================================================

USE `hrms_ai`;

-- -----------------------------------------------------------------------------
-- 1. Shifts — defines named work schedules
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `attendance_shifts` (
  `id`                      INT AUTO_INCREMENT PRIMARY KEY,
  `name`                    VARCHAR(100) NOT NULL,
  `start_time`              TIME NOT NULL DEFAULT '09:00:00',
  `end_time`                TIME NOT NULL DEFAULT '18:00:00',
  `break_minutes`           INT NOT NULL DEFAULT 60,
  `grace_minutes`           INT NOT NULL DEFAULT 15,
  `is_flexible`             TINYINT(1) NOT NULL DEFAULT 0,
  `flex_hours_per_day`      FLOAT NOT NULL DEFAULT 8.0,
  `overtime_after_minutes`  INT NOT NULL DEFAULT 540,
  `is_night_shift`          TINYINT(1) NOT NULL DEFAULT 0,
  `is_active`               TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`              VARCHAR(255) NOT NULL DEFAULT '',
  `created_at`              DATETIME NOT NULL DEFAULT NOW()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `attendance_shifts`
  (`id`,`name`,`start_time`,`end_time`,`break_minutes`,`grace_minutes`,`is_flexible`,`flex_hours_per_day`,`overtime_after_minutes`,`created_by`)
VALUES
  (1,'General Shift','09:00:00','18:00:00',60,15,0,8.0,540,'system'),
  (2,'Morning Shift','06:00:00','14:00:00',30,10,0,8.0,480,'system'),
  (3,'Night Shift','22:00:00','06:00:00',30,10,0,8.0,480,'system'),
  (4,'Flexible','09:00:00','18:00:00',60,60,1,8.0,540,'system');

-- -----------------------------------------------------------------------------
-- 2. Shift Assignments
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `shift_assignments` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `email`           VARCHAR(255) NOT NULL,
  `shift_id`        INT NOT NULL,
  `effective_from`  DATE NOT NULL,
  `effective_to`    DATE NULL DEFAULT NULL,
  `created_by`      VARCHAR(255) NOT NULL DEFAULT '',
  `created_at`      DATETIME NOT NULL DEFAULT NOW(),
  INDEX `idx_sa_email`  (`email`),
  INDEX `idx_sa_shift`  (`shift_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 3. Attendance Correction Requests
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `attendance_corrections` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `email`               VARCHAR(255) NOT NULL,
  `employee_name`       VARCHAR(255) NOT NULL DEFAULT '',
  `attendance_date`     DATE NOT NULL,
  `requested_check_in`  DATETIME NULL DEFAULT NULL,
  `requested_check_out` DATETIME NULL DEFAULT NULL,
  `reason`              TEXT NULL,
  `status`              VARCHAR(20) NOT NULL DEFAULT 'Pending',
  `reviewer`            VARCHAR(255) NOT NULL DEFAULT '',
  `reviewer_note`       TEXT NULL,
  `reviewed_at`         DATETIME NULL DEFAULT NULL,
  `created_at`          DATETIME NOT NULL DEFAULT NOW(),
  INDEX `idx_ac_email`  (`email`),
  INDEX `idx_ac_date`   (`attendance_date`),
  INDEX `idx_ac_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 4. Geofences
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `attendance_geofences` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `name`          VARCHAR(100) NOT NULL,
  `latitude`      DOUBLE NOT NULL,
  `longitude`     DOUBLE NOT NULL,
  `radius_meters` INT NOT NULL DEFAULT 200,
  `is_active`     TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`    VARCHAR(255) NOT NULL DEFAULT '',
  `created_at`    DATETIME NOT NULL DEFAULT NOW()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 5. WFH Requests
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wfh_requests` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `email`         VARCHAR(255) NOT NULL,
  `employee_name` VARCHAR(255) NOT NULL DEFAULT '',
  `from_date`     DATE NOT NULL,
  `to_date`       DATE NOT NULL,
  `days`          INT NOT NULL DEFAULT 1,
  `reason`        TEXT NULL,
  `status`        VARCHAR(20) NOT NULL DEFAULT 'Pending',
  `approver`      VARCHAR(255) NOT NULL DEFAULT '',
  `created_at`    DATETIME NOT NULL DEFAULT NOW(),
  `updated_at`    DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  INDEX `idx_wfh_email`  (`email`),
  INDEX `idx_wfh_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 6. Extend employee_attendance
-- -----------------------------------------------------------------------------
ALTER TABLE `employee_attendance`
  ADD COLUMN IF NOT EXISTS `shift_id`           INT        NULL DEFAULT NULL AFTER `note`,
  ADD COLUMN IF NOT EXISTS `is_wfh`             TINYINT(1) NOT NULL DEFAULT 0 AFTER `shift_id`,
  ADD COLUMN IF NOT EXISTS `break_minutes`      INT        NOT NULL DEFAULT 0 AFTER `is_wfh`,
  ADD COLUMN IF NOT EXISTS `overtime_minutes`   INT        NOT NULL DEFAULT 0 AFTER `break_minutes`,
  ADD COLUMN IF NOT EXISTS `late_minutes`       INT        NOT NULL DEFAULT 0 AFTER `overtime_minutes`,
  ADD COLUMN IF NOT EXISTS `early_exit_minutes` INT        NOT NULL DEFAULT 0 AFTER `late_minutes`,
  ADD COLUMN IF NOT EXISTS `location_lat`       DOUBLE     NULL DEFAULT NULL  AFTER `early_exit_minutes`,
  ADD COLUMN IF NOT EXISTS `location_lng`       DOUBLE     NULL DEFAULT NULL  AFTER `location_lat`,
  ADD COLUMN IF NOT EXISTS `geo_verified`       TINYINT(1) NOT NULL DEFAULT 0 AFTER `location_lng`;

-- -----------------------------------------------------------------------------
-- 7. Extend attendance_events with GPS
-- -----------------------------------------------------------------------------
ALTER TABLE `attendance_events`
  ADD COLUMN IF NOT EXISTS `latitude`     DOUBLE NULL DEFAULT NULL AFTER `location`,
  ADD COLUMN IF NOT EXISTS `longitude`    DOUBLE NULL DEFAULT NULL AFTER `latitude`,
  ADD COLUMN IF NOT EXISTS `geo_fence_id` INT    NULL DEFAULT NULL AFTER `longitude`;

-- =============================================================================
-- Done. Next: python manage.py migrate
-- =============================================================================

/**
 * HRMS Attendance Module - Component Exports
 * Central export file for all attendance components
 */

export { default as AttendanceCheckIn } from './AttendanceCheckIn';
export { default as AttendanceBreak } from './AttendanceBreak';
export { default as OvertimeDashboard } from './OvertimeDashboard';
export { default as WFHRequestComponent } from './WFHRequest';
export { default as ManagerDashboard } from './ManagerDashboard';
export { default as AdminDashboard } from './AdminDashboard';
export { default as NotificationCenter } from './NotificationCenter';

// Component usage guide:
// 
// 1. Employee Check-In/Out:
//    import { AttendanceCheckIn } from './components';
//    <AttendanceCheckIn />
//
// 2. Break Management:
//    import { AttendanceBreak } from './components';
//    <AttendanceBreak />
//
// 3. Overtime Tracking:
//    import { OvertimeDashboard } from './components';
//    <OvertimeDashboard />
//
// 4. WFH Requests:
//    import { WFHRequestComponent } from './components';
//    <WFHRequestComponent />
//
// 5. Manager Dashboard:
//    import { ManagerDashboard } from './components';
//    <ManagerDashboard />
//
// 6. Admin Dashboard:
//    import { AdminDashboard } from './components';
//    <AdminDashboard />
//
// 7. Notification Center:
//    import { NotificationCenter } from './components';
//    <NotificationCenter />
//
// All components require:
// - localStorage.auth_token (for API authentication)
// - localStorage.employee_email (employee email)
// - localStorage.employee_name (employee name, optional)
// - Backend running on http://localhost:8000

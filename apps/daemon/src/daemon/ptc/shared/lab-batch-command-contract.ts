export type PtcLabBatchCommandFailureReason =
  | 'ptc_lab_admission_required'
  | 'ptc_lab_shell_disabled'
  | 'ptc_lab_session_unavailable'
  | 'ptc_lab_policy_mismatch'
  | 'ptc_lab_interpreter_unavailable'
  | 'ptc_lab_command_invalid'
  | 'ptc_lab_command_timeout'
  | 'ptc_lab_command_cancelled'
  | 'ptc_lab_command_output_rejected'
  | 'ptc_lab_command_failed';

export type PtcLabSessionBatchCommandFailureReason =
  | PtcLabBatchCommandFailureReason
  | 'ptc_lab_session_busy';

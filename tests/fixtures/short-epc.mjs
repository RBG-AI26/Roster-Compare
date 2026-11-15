export function shortEpcRoster({ course = true, coursePort = 'MEL', outboundPort = 'MEL', courseTimes = true } = {}) {
  const row = (day, code, service, report, end, port = '') => `${day.padEnd(8)}${code.padEnd(12)}${service.padEnd(28)}${report.padEnd(5)}${end.padEnd(5)}${''.padEnd(6)}${''.padEnd(7)}${port.padEnd(5)}`;
  return `SH Flight Crew Roster - Bid Period 1
Name: TEST PILOT A  Category: CPT
Staff No: 123456  Base: ADL
12 Dec 2026 - 14 Dec 2026
Date    Duty(Role)                  S-On S-Of
${row('12 Sat', 'COURSE1', 'P101', '1345', '1615', 'MEL')}
${row('13 Sun', '', 'CEP29/P102', '0735', '1800')}
${row('13 Sun', 'EP29', '', courseTimes ? '0705' : '', courseTimes ? '1455' : '')}
${row('14 Mon', 'D/O', '', '', '')}
Global Preferences
Pattern Details
12Dec P 101 ADL 1415 MEL 1600
Rpt 1345 Rls 1615
${course ? `13Dec C EP29 ${coursePort} 0735 ${coursePort} 1525` : ''}
13Dec P 102 ${outboundPort} 1655 ADL 1745
Rpt 0735 Rls 1800
COURSE1 DATED 12Dec26
*** End of Report
`;
}

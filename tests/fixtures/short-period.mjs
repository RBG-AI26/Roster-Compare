export function shortPeriod({ start = new Date(2026, 10, 2), staff = '123456', name = 'TEST PILOT A', issued = '15Nov26 1055', duty = 'D/O', bid = '1' } = {}) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const end = new Date(start); end.setDate(end.getDate() + 27);
  const printed = date => `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
  const rows = Array.from({ length: 28 }, (_, index) => {
    const date = new Date(start); date.setDate(date.getDate() + index);
    return `${String(date.getDate()).padStart(2, '0')} ${weekdays[date.getDay()]}  ${typeof duty === 'function' ? duty(index) : duty}`;
  });
  return `QANTAS AIRWAYS LIMITED ${issued}\nSH Flight Crew Roster - Bid Period ${bid}\nName: ${name}  Category: CPT\n${staff ? `Staff No: ${staff}\n` : ''}Base: MEL\n${printed(start)} - ${printed(end)}\nDate    Duty(Role)                  S-On S-Of\n${rows.join('\n')}\nGlobal Preferences\n`;
}

// Split so antivirus scanners do not flag this source file.
const parts = ['X5O!P%@AP[4', String.fromCharCode(92), 'PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'];

export const eicarBytes = (): Buffer => Buffer.from(parts.join(''), 'latin1');

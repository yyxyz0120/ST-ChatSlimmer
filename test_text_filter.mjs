import {
    applyTextFilterRules,
    planTextFilterClean,
    applyTextFilterToMessage,
} from './core.js';

const rules = [
    { start: '<disclaimer>', end: '</disclaimer>' },
    { start: '<StatusPlaceHolderImpl/>', end: '' },
    { start: '', end: '</konatan_planning~>' },
];

const sample = 'hello<disclaimer>warn</disclaimer>world<StatusPlaceHolderImpl/>!';
const applied = applyTextFilterRules(sample, rules);
console.assert(applied.text === 'helloworld!', applied.text);
console.assert(applied.changed === true);

const orphanedPlanning = '- 現在の状況\n * 時間：昼\n</konatan_planning~>\n\n[HEADER|标题]\n正文';
const appliedPlanning = applyTextFilterRules(orphanedPlanning, [
    { start: '', end: '</konatan_planning~>' },
]);
console.assert(appliedPlanning.text === '\n\n[HEADER|标题]\n正文', appliedPlanning.text);
console.assert(appliedPlanning.changed === true);

const chat = [
    { mes: 'a<disclaimer>x</disclaimer>b', swipes: ['a<disclaimer>x</disclaimer>b'] },
    { mes: 'clean' },
];
const plan = planTextFilterClean(chat, 0, rules);
console.assert(plan.targets.length === 1 && plan.targets[0] === 0);
console.assert(plan.bytes > 0);

applyTextFilterToMessage(chat[0], rules);
console.assert(chat[0].mes === 'ab');
console.assert(chat[0].swipes[0] === 'ab');

console.log('core text filter tests passed');

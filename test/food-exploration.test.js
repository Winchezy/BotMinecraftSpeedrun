const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const GetFood = require('../src/tasks/GetFood');

test('food exploration prefers substantial progress over tiny steps', () => {
    const task = Object.create(GetFood.prototype);
    task.bot = {};
    const start = new Vec3(0,64,0);
    assert.ok(task.explorationScore(new Vec3(10,64,0),start) > task.explorationScore(new Vec3(3,64,0),start));
});

test('food exploration keeps its heading and penalizes climbing back up', () => {
    const task = Object.create(GetFood.prototype);
    task.bot = {foodExplorationDirection:{x:1,z:0}};
    const start = new Vec3(0,64,0);
    assert.ok(task.explorationScore(new Vec3(10,64,0),start) > task.explorationScore(new Vec3(-10,64,0),start));
    assert.ok(task.explorationScore(new Vec3(10,64,0),start) > task.explorationScore(new Vec3(10,65,0),start));
});

test('search radius increases across tasks until food is found',()=>{
    const bot={version:'1.20.4'};
    const first=new GetFood(bot);
    first.expandSearch();first.expandSearch();
    assert.equal(first.searchArea.radius,64);
    const next=new GetFood(bot);
    next.searchArea.lastExpansion=0;
    next.expandSearch();next.expandSearch();
    assert.equal(next.searchArea.radius,96);
});

test('notices newly loaded food during a journey and cancels its goal',async()=>{
    let stopped=false;
    const task=Object.create(GetFood.prototype);
    task.bot={entities:{},entity:{position:new Vec3(0,64,0)},
        pathfinder:{setGoal:goal=>{stopped=goal===null;}},clearControlStates(){}};
    const watcher=task.watchForFood();
    task.bot.entities[1]={id:1,name:'cow',position:new Vec3(5,64,0)};
    try {await watcher.promise;assert.equal(stopped,true);}
    finally {watcher.stop();}
});

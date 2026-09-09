import * as THREE from 'three/webgpu';
import type { Input } from '../../core/input';
import type { PlayerCtx, ModeFrame, ModeController } from '../../player/types';
import { BoatController } from '../boat/controller';
import { BOAT_TUNING } from '../boat/tuning';
import { YACHT_HULL } from './dimensions';
import { yachtEntry } from './entry';
import { DECKS, STAIRS, moveOnDeck } from './navigation';
import { PASSENGERS } from './stories';
import { addYachtPassengers } from './index';
import type { Rig } from '../../player/rig';

const tuning = { ...BOAT_TUNING, values: { ...BOAT_TUNING.values,
  maxSpeed: 12, boostMaxSpeed: 18, reverseMax: 4, accel: 1.8, boostAccel: 2.5,
  reverseAccel: 2, steerRate: .23, heaveDamp: 10, waveSurge: .08, trimRate: 3
} };
const idle = { axis: () => 0, down: () => false } as unknown as Input;
export class YachtController implements ModeController {
  readonly spawnLift = .8;
  readonly boat = new BoatController(tuning,YACHT_HULL, [9.5,2.6,37]);
  readonly eye = new THREE.Vector3(0,9.25,-9.2);
  readonly foot = new THREE.Vector3(0,3.3,12);
  exploring = false;
  flying = false;
  deck = 0;
  secret = false;
  #heli: THREE.Object3D;
  #root: THREE.Group;
  #rotor: THREE.Object3D;
  #door: THREE.Object3D;
  #heliHome: THREE.Vector3;
  #heliRest: THREE.Quaternion;
  #rigs;
  #panel: HTMLDivElement;
  #heading: HTMLElement;
  #copy: HTMLElement;
  #action: HTMLButtonElement;
  #return: HTMLButtonElement;
  #line = new Map<number,number>();
  #message = '';
  #messageUntil = 0;
  #clock = 0;
  #active = false;
  #rHeld = false;
  #target = '';
  #flight = new THREE.Vector3();
  #tmp = new THREE.Vector3();
  #inverse = new THREE.Quaternion();
  #avatarRig: Rig | null = null;
  #avatarHome: THREE.Group | null = null;
  #avatarSpeed = 0;
  constructor(root: THREE.Group) {
    this.#root=root;
    this.#heli=root.getObjectByName('Helicopter')!;
    this.#rotor=root.getObjectByName('HelicopterRotor')!;
    this.#door=root.getObjectByName('SecretDoor')!;
    this.#heliHome=this.#heli.position.clone(); this.#heliRest=this.#heli.quaternion.clone();
    this.#rigs=addYachtPassengers(root);
    this.#panel=document.createElement('div'); this.#panel.dataset.yacht='elsewhere'; this.#panel.hidden=true;
    Object.assign(this.#panel.style,{position:'fixed',right:'22px',top:'110px',width:'min(330px, calc(100vw - 44px))',padding:'20px',background:'rgba(8,29,39,.94)',border:'1px solid #bca16a',borderRadius:'15px',color:'#f6efdd',font:'14px/1.55 system-ui',zIndex:'35',boxShadow:'0 12px 45px #0005'});
    this.#heading=document.createElement('strong'); this.#heading.textContent='THE ELSEWHERE';
    this.#copy=document.createElement('p'); this.#copy.style.whiteSpace='pre-line';
    this.#action=document.createElement('button');this.#action.onclick=()=>this.interact();
    this.#return=document.createElement('button');this.#return.textContent='Return to helm · R';this.#return.onclick=()=>this.returnToHelm();
    for(const b of [this.#action,this.#return])Object.assign(b.style,{display:'block',width:'100%',padding:'10px',marginTop:'9px',border:'1px solid #a58e61',borderRadius:'8px',background:'#204650',color:'#fff2d5',cursor:'pointer',font:'inherit'});
    this.#panel.append(this.#heading,this.#copy,this.#action,this.#return);document.body.append(this.#panel);
  }
  get status() { return { exploring:this.exploring, flying:this.flying, deck:this.deck, secret:this.secret, foot:this.foot.toArray(), eye:this.eye.toArray(), helicopter:this.#heli.position.toArray(), target:this.#target }; }
  get avatarSpeed() { return this.#avatarSpeed; }
  /** The player's shared avatar rig is reparented here only while exploring. */
  setAvatarRig(rig: Rig, home: THREE.Group) {
    this.#avatarRig = rig;
    this.#avatarHome = home;
    rig.group.name = 'yacht_local_avatar';
    rig.group.visible = false;
  }
  setAvatarExploring(exploring: boolean) {
    if (!this.#avatarRig || !this.#avatarHome) return;
    if (exploring) {
      if (this.#avatarRig.group.parent !== this.#root) this.#root.add(this.#avatarRig.group);
      this.#avatarRig.group.visible = true;
    } else {
      if (this.#avatarRig.group.parent !== this.#avatarHome) this.#avatarHome.add(this.#avatarRig.group);
      this.#avatarRig.group.position.set(0, 0, 0);
      this.#avatarRig.group.rotation.set(0, 0, 0);
      this.#avatarRig.group.visible = false;
    }
  }
  setActive(active: boolean) {
    this.#active=active;
    this.#panel.hidden=!active;
    this.setAvatarExploring(active && this.exploring);
    if(!active)this.returnToHelm();
  }
  spawnBody(ctx: PlayerCtx,facing: number) { this.returnToHelm();return this.boat.spawnBody(ctx,facing); }
  enter(ctx: PlayerCtx) {
    const spot = yachtEntry(ctx);
    ctx.position.set(spot.x,0,spot.z);
  }
  returnToHelm() {
    this.exploring=false;this.flying=false;this.#avatarSpeed=0;this.deck=0;this.eye.set(0,9.25,-9.2);
    this.setAvatarExploring(false);
    this.#heli.visible=true;this.#heli.position.copy(this.#heliHome);this.#heli.quaternion.copy(this.#heliRest);this.#message='';this.refresh();
  }
  interact() {
    if(!this.exploring){
      this.exploring=true;this.flying=false;this.#avatarSpeed=0;this.foot.set(0,3.3,12);this.deck=0;this.eye.copy(this.foot).y+=1.65;
      this.setAvatarExploring(true);
      this.refresh();return;
    }
    if(this.flying){
      const nearest=[{x:0,y:3.45,z:-29},{x:0,y:11.5,z:18}].find(p=>Math.hypot(this.#flight.x-p.x,this.#flight.z-p.z)<5&&Math.abs(this.#flight.y-p.y)<4);
      if(nearest){this.flying=false;this.#heli.visible=true;this.deck=nearest.z<0?0:2;this.#heli.position.set(nearest.x,nearest.y,nearest.z);this.foot.set(3.5,DECKS[this.deck].y,nearest.z);this.say('Moth is safely down. The cake survived.');}
      else this.say('Bring Moth within the gold circle and descend gently to land. R returns you and Moth safely to the yacht.');
      this.refresh();return;
    }
    this.refresh();
    if(this.#target.startsWith('guest:')){
      const i=Number(this.#target.slice(6)),p=PASSENGERS[i],n=this.#line.get(i)??0;
      this.say(`${p.name}\n\n“${p.story[n%p.story.length]}”`);this.#line.set(i,n+1);
    }else if(this.#target==='secret'){
      this.secret=!this.secret;this.#door.visible=!this.secret;
      this.say(this.secret?'The star gives way. Beyond it: the Museum of Almosts. A whale carries the homes we have not found yet. Leave a little room for your own impossible thing.':'The little museum will keep your place.');
    }else if(this.#target==='helicopter'){
      this.flying=true;this.#heli.visible=false;this.#flight.copy(this.#heli.position);this.#flight.y+=2;this.say('MOTH · WASD to fly · Space to climb · Q to descend · E to land on either pad');
    }else if(this.#target==='stairs:up')this.takeStairs(1);
    else if(this.#target==='stairs:down')this.takeStairs(-1);
    else if(this.#target==='pool')this.say('Float a moment. Nobody aboard is timing your arrival. The water is warm, and the next port can wait.');
    else if(this.#target==='spa')this.say('Sky Spa · salt air, warm bubbles, absolutely no appointments. Somewhere below, the whole ocean is taking a bath too.');
    else if(this.#target==='art')this.say('“Coordinates for an Unfinished Journey” · brass, borrowed starlight, and four colors found in a stranger’s scarf. Every orbit leaves room for one more moon.');
    this.refresh();
  }
  takeStairs(direction:number){
    const stair=STAIRS[direction>0?this.deck:this.deck-1];this.deck+=direction;
    this.foot.set(stair.x,DECKS[this.deck].y,direction>0?stair.z-8.6:stair.z+1);
    // Upper promenade narrows: step inward off the stair landing.
    this.foot.x=THREE.MathUtils.clamp(this.foot.x,-DECKS[this.deck].halfWidth+.5,DECKS[this.deck].halfWidth-.5);
    this.eye.copy(this.foot).y+=1.65;
  }
  say(message:string){this.#message=message;this.#messageUntil=this.#clock+18;}
  refresh(){
    if(!this.#panel)return;
    this.#target='';let label='Explore the decks · E';
    let desc='A little farther from ordinary.\n\nW/S throttle · A/D steer · Shift cruise\nTwo pools · sky spa · art · four fellow wanderers';
    if(this.exploring){
      label='Explore · WASD / mouse';
      desc=`${['Main deck · art, sound & pool','Terrace · bridge & infinity pool','Sun deck · sky spa & heliport'][this.deck]}\nWASD to walk · E to interact · R for helm`;
      const near=(x:number,y:number,z:number,r=2.8)=>this.foot.distanceTo(this.#tmp.set(x,y,z))<r;
      if(this.flying){label='Land on a helipad · E';desc='MOTH · a small helicopter for a very big sky\nWASD fly · Space rise · Q descend · R return';}
      else {
        for(let i=0;i<PASSENGERS.length;i++){const p=PASSENGERS[i];if(near(p.at[0],p.at[1],p.at[2])){this.#target=`guest:${i}`;label=`Talk to ${p.name.split(' ·')[0]} · E`;}}
        if(near(0,3.3,-11.8,3)){this.#target='secret';label=this.secret?'Close the star door · E':'Examine the gold star · E';}
        if(near(this.#heli.position.x,DECKS[this.deck].y,this.#heli.position.z,5)&&Math.abs(DECKS[this.deck].y-this.#heli.position.y)<1){this.#target='helicopter';label='Fly Moth · E';}
        for(const s of STAIRS){if(this.deck===s.lower&&near(s.x,DECKS[this.deck].y,s.z,3)){this.#target='stairs:up';label='Climb the promenade stairs · E';}else if(this.deck===s.lower+1&&near(THREE.MathUtils.clamp(s.x,-DECKS[this.deck].halfWidth+.5,DECKS[this.deck].halfWidth-.5),DECKS[this.deck].y,s.z-8.6,3)){this.#target='stairs:down';label='Descend the promenade stairs · E';}}
        if(!this.#target&&this.deck===0&&near(0,3.3,31.5,4)){this.#target='pool';label='Take a poolside pause · E';}
        if(!this.#target&&this.deck===1&&near(0,7.3,7,4)){this.#target='pool';label='Enjoy the infinity pool · E';}
        if(!this.#target&&this.deck===2&&near(0,11.3,-5,3)){this.#target='spa';label='Relax in the sky spa · E';}
        if(!this.#target&&this.deck===0&&Math.abs(this.foot.x)>2&&[-5,3].some(z=>Math.abs(this.foot.z-z)<2)){this.#target='art';label='Read the artwork · E';}
      }
    }
    if(this.#message&&this.#clock<this.#messageUntil)desc=this.#message;
    if(this.#copy.textContent!==desc)this.#copy.textContent=desc;
    if(this.#action.textContent!==label)this.#action.textContent=label;
    this.#action.disabled=this.exploring&&!this.flying&&!this.#target;
    this.#return.style.display=this.exploring ? "block" : "none";
  }
  update(ctx:PlayerCtx,dt:number,input:Input,frame:ModeFrame){
    this.#clock+=dt;
    const r=input.down('KeyR');if(r&&!this.#rHeld)this.returnToHelm();this.#rHeld=r;
    this.boat.update(ctx,dt,this.exploring?idle:input,frame);
    if(this.exploring){
      this.setAvatarExploring(true);
      // Anchored while people walk; the same buoyancy still supplies gentle heave.
      const v=ctx.physics.world.getBodyVelocity(ctx.body);
      ctx.physics.world.setBodyVelocity(ctx.body,[0,v.linear[1],0],[0,0,0]);
      const forward=input.axis('KeyS','KeyW'),right=input.axis('KeyA','KeyD');
      this.#tmp.set(right*Math.cos(frame.camYaw)-forward*Math.sin(frame.camYaw),0,-right*Math.sin(frame.camYaw)-forward*Math.cos(frame.camYaw));
      this.#inverse.copy(ctx.quaternion).invert();this.#tmp.applyQuaternion(this.#inverse);this.#tmp.y=0;
      const requestedSpeed = this.flying ? 22 : input.down('ShiftLeft') ? 5 : 3;
      const requestedDistance = this.#tmp.length();
      if(this.#tmp.length()>1)this.#tmp.normalize();this.#tmp.multiplyScalar(dt*requestedSpeed);
      if(this.flying){
        this.#flight.add(this.#tmp);this.#flight.y+=((input.down('Space')?1:0)-(input.down('KeyQ')?1:0))*dt*9;
        const world=ctx.position.clone().add(this.#flight.clone().applyQuaternion(ctx.quaternion));
        const clearance=ctx.map.effectiveGround(world.x,world.z)+5-world.y;
        // Convert vertical world clearance back through the anchored hull tilt.
        const localUpY=1-2*(ctx.quaternion.x**2+ctx.quaternion.z**2);
        if(clearance>0)this.#flight.y+=clearance/Math.max(.5,localUpY);
        this.#flight.y=Math.max(this.#flight.y,3.5);
        // Above the yacht's superstructure, descend only over one of the clear pads.
        if(Math.abs(this.#flight.x)<11&&this.#flight.z>-40&&this.#flight.z<36){
          const bow=Math.hypot(this.#flight.x,this.#flight.z+29)<5;
          const stern=Math.hypot(this.#flight.x,this.#flight.z-18)<5;
          this.#flight.y=Math.max(this.#flight.y,bow?3.5:stern?11.5:17);
        }
        if(this.#flight.length()>1200)this.#flight.setLength(1200);
        this.#heli.position.copy(this.#flight);
        this.#heli.quaternion.copy(this.#heliRest);
        this.eye.copy(this.#flight).add(this.#tmp.set(0,2.1,-1.2));
      }else{
        moveOnDeck(this.foot,this.#tmp.x,this.#tmp.z,this.deck,this.secret);
        this.eye.copy(this.foot).y+=1.65;
      }
      this.#avatarSpeed = this.flying ? 0 : Math.min(5, requestedDistance / Math.max(dt, 1e-4));
      if (this.#avatarRig) {
        this.#avatarRig.group.visible = true;
        this.#avatarRig.group.position.set(this.foot.x, this.foot.y + 1.1, this.foot.z);
        if (requestedDistance > 0.0001) {
          const heading = Math.atan2(this.#tmp.x, this.#tmp.z);
          this.#avatarRig.group.rotation.y = heading;
        }
      }
    } else {
      this.#avatarSpeed = 0;
      this.setAvatarExploring(false);
    }
    // glTF bakes the rotor into the game's Y-up coordinate frame.
    if(this.flying)this.#rotor.rotateY(dt*35);
    for(let i=0;i<this.#rigs.length;i++){const rig=this.#rigs[i];rig.head.rotation.y=Math.sin(this.#clock*.45+i)*.2;rig.armR.rotation.x=Math.sin(this.#clock*.8+i)*.08;}
    if(this.#active)this.refresh();
  }
}

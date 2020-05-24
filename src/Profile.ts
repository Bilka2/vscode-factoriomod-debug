import { TextEditor, window, TextEditorDecorationType, DecorationOptions, Range, OverviewRulerLane, Disposable, StatusBarItem, workspace, ThemeColor } from "vscode";

type FileProfileData = Map<number,number>;
type FileCountData = Map<number,number>;
type ModFileProfileData = {profile:FileProfileData;count:FileCountData;fnprofile:FileProfileData;fncount:FileCountData};
type ModProfileData = Map<string,ModFileProfileData>;


function NaN_safe_max(a:number,b:number):number {
	if (isNaN(a)) { return b; }
	if (isNaN(b)) { return a; }
	return Math.max(a,b);
}

export class Profile implements Disposable {
	private profileData = new Map<string,ModProfileData>();
	private profileOverhead:number;
	private timeDecorationType: TextEditorDecorationType;
	private funcDecorationType: TextEditorDecorationType;
	private rulerDecorationTypes: {type:TextEditorDecorationType;threshold:number}[];
	private statusBar: StatusBarItem;

	constructor()
	{
		this.timeDecorationType = window.createTextEditorDecorationType({
			before: {
				contentText:"",
				color: workspace.getConfiguration().get("factorio.profile.timerTextColor"),
			}
		});
		this.funcDecorationType = window.createTextEditorDecorationType({
			after: {
				contentText: "",
				color: workspace.getConfiguration().get("factorio.profile.timerTextColor"),
			},
		});

		let rulers = workspace.getConfiguration().get<{color:string;threshold:number}[]>("factorio.profile.rulers",[]);
		this.rulerDecorationTypes = rulers.map(ruler=>{
			return {
				type: window.createTextEditorDecorationType({
					overviewRulerColor: ruler.color,
					overviewRulerLane: OverviewRulerLane.Right
				}),
				threshold: ruler.threshold
			};
		});
		this.statusBar = window.createStatusBarItem();

	}
	dispose() {
		this.timeDecorationType.dispose();
		this.funcDecorationType.dispose();
		this.rulerDecorationTypes.forEach(ruler=>{ruler.type.dispose();});
		this.statusBar.dispose();
	}

	public parse(profile:string)
	{
		const lines = profile.split("\n");
		const newprofile = new Map<string,ModProfileData>();
		let newoverhead:number = NaN;
		let currmod:string;
		let currfile:string;
		lines.forEach(line => {
			const parts = line.split(":");
			switch(parts[0])
			{
				case "PROFILE": // nothing
					break;
				case "PMN": // PMN:modname
					currmod = parts[1].replace(/[\r\n]*/g,"");
					newprofile.set(currmod,new Map<string,ModFileProfileData>());
					break;
				case "PFN": // PFN:filename
					if (currmod)
					{
						const mod = newprofile.get(currmod)!;
						currfile = parts[1].replace(/[\r\n]*/g,"");
						mod.set(currfile,{
							profile:new Map<number,number>(),
							count:new Map<number,number>(),
							fnprofile:new Map<number,number>(),
							fncount:new Map<number,number>(),
						});
					}
					break;
				case "PLN": // PLN:line:label: time:count
					if (currmod && currfile)
					{
						const mod = newprofile.get(currmod)!;
						const file = mod.get(currfile)!;
						const line = parseInt(parts[1]);
						const time = parseFloat(parts[3]);
						const count = parseInt(parts[4]);
						file.profile.set(line,time);
						file.count.set(line,count);
					}
					break;
				case "PFT": // PFT:line:label: time:count
					if (currmod && currfile)
					{
						const mod = newprofile.get(currmod)!;
						const file = mod.get(currfile)!;
						const line = parseInt(parts[1]);
						const time = parseFloat(parts[3]);
						const count = parseInt(parts[4]);
						file.fnprofile.set(line,time);
						file.fncount.set(line,count);
					}
					break;
				case "POV": //POV:label: time
					{
						const time =  parseFloat(parts[2]);
						newoverhead = time;
					}
			}
		});
		this.profileData = newprofile;
		this.profileOverhead = newoverhead;
	}

	public render(editor:TextEditor,filename:string)
	{
		const filetimes = new Map<number,number>();
		const filecounts = new Map<number,number>();
		const filefntimes = new Map<number,number>();
		const filefncounts = new Map<number,number>();
		let maxtime = 0.0;
		let maxavg = 0.0;
		let maxcount = 0;
		let maxfntime = 0.0;
		let maxfnavg = 0.0;
		let maxfncount = 0;
		this.profileData.forEach(modprofile => {
			const file = modprofile.get(filename);
			if (file)
			{
				file.profile.forEach((time,line) => {
					const newtime = time + (filetimes.get(line)??0);
					maxtime = NaN_safe_max(maxtime,newtime);
					const newavg = newtime / file.count.get(line)!;
					maxavg = NaN_safe_max(maxavg,newavg);
					filetimes.set(line,newtime);
				});
				file.count.forEach((count,line) => {
					const newcount = count + (filecounts.get(line)??0);
					maxcount = NaN_safe_max(maxcount,newcount);
					filecounts.set(line,newcount);
				});
				file.fnprofile.forEach((time,line) => {
					const newtime = time + (filefntimes.get(line)??0);
					maxfntime = NaN_safe_max(maxfntime,newtime);
					const newavg = newtime / file.fncount.get(line)!;
					maxfnavg = NaN_safe_max(maxfnavg,newavg);
					filefntimes.set(line,newtime);
				});

				file.fncount.forEach((count,line) => {
					const newcount = count + (filefncounts.get(line)??0);
					maxfncount = NaN_safe_max(maxfncount,newcount);
					filefncounts.set(line,newcount);
				});
			}
		});
		let linedecs = new Array<DecorationOptions>();
		let funcdecs = new Array<DecorationOptions>();
		let rulerthresholds = this.rulerDecorationTypes.map((ruler,i)=>{
			return {
				type: ruler.type,
				threshold: ruler.threshold,
				decs: new Array<DecorationOptions>()
			};
		});
		const displayAverageTime = workspace.getConfiguration().get("factorio.profile.displayAverageTime");
		const colorBy = workspace.getConfiguration().get<"count"|"totaltime"|"averagetime">("factorio.profile.colorBy","totaltime");

		const highlightColor = workspace.getConfiguration().get("factorio.profile.timerHighlightColor");
		const scalemax = {"count": maxcount, "totaltime":maxtime, "averagetime":maxavg }[colorBy];
		const scale = {
			"boost": (x:number)=>{return Math.log(1+x)/Math.log(1+scalemax);},
			"custom": (x:number)=>{return Math.pow(x/scalemax,workspace.getConfiguration().get<number>("factorio.profile.colorScaleCustom",1));},
			"mute": (x:number)=>{return (Math.pow(1+scalemax,x/scalemax)-1)/scalemax;},
		}[workspace.getConfiguration().get<"boost"|"custom"|"mute">("factorio.profile.colorScaleMode","boost")];

		const countwidth = maxcount.toFixed(0).length+1;
		const timeprecision = displayAverageTime ? 6 : 3;
		const timewidth = maxtime.toFixed(timeprecision).length+1;
		const width = countwidth+timewidth+3;

		for (let line = 1; line <= editor.document.lineCount; line++) {
			const time = filetimes.get(line);
			if (time)
			{
				const count = filecounts.get(line)!;
				const displayTime = displayAverageTime ? time/count : time;
				const t = scale({"count": count, "totaltime":time, "averagetime":time/count }[colorBy]);
				const range = editor.document.validateRange(new Range(line-1,0,line-1,1/0));
				linedecs.push({
					range: range,
					renderOptions: {
						before: {
							backgroundColor: `${highlightColor}${Math.floor(255*t).toString(16)}`,
							contentText: `${count.toFixed(0).padStart(countwidth,"\u00A0")}${displayTime.toFixed(timeprecision).padStart(timewidth,"\u00A0")}\u00A0ms`,
							width: `${width+1}ch`,
						}
					}
				});
				let ruler = rulerthresholds.find(ruler=>{return t >= ruler.threshold;});
				if (ruler)
				{
					ruler.decs.push({
						range: range,
					});
				}
			}
			else
			{
				linedecs.push({
					range: editor.document.validateRange(new Range(line-1,0,line-1,1/0)),
					renderOptions: {
						before: {
							width: `${width+1}ch`,
						}
					}
				});
			}

			const functime = filefntimes.get(line);
			if (functime)
			{
				const count = filefncounts.get(line)!;
				const displayTime = displayAverageTime ? functime/count : functime;
				const range = editor.document.validateRange(new Range(line-1,0,line-1,1/0));
				funcdecs.push({
					range: range,
					renderOptions: {
						after: {
							contentText: ` ${count.toFixed(0)}\u00A0${displayTime.toFixed(timeprecision)} ms`,
						}
					}
				});
			}
		}

		editor.setDecorations(this.timeDecorationType,linedecs);
		editor.setDecorations(this.funcDecorationType,funcdecs);

		rulerthresholds.forEach((ruler)=>{
			editor.setDecorations(ruler.type,ruler.decs);
		});
		this.statusBar.text = `Profile Dump took ${this.profileOverhead.toFixed(3)} ms`;
		this.statusBar.show();
	}

	public clear()
	{
		window.visibleTextEditors.forEach(editor => {
			editor.setDecorations(this.timeDecorationType,[]);
			editor.setDecorations(this.funcDecorationType,[]);
			this.rulerDecorationTypes.forEach(ruler=>{
				editor.setDecorations(ruler.type,[]);
			});
		});
		this.statusBar.hide();
	}
}
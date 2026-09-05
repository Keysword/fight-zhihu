export interface ZhihuSearchItem {
	Title: string;
	ContentType: string;
	ContentID: string;
	ContentText: string;
	Url: string;
	AuthorName: string;
	EditTime: number;
	AuthorityLevel: string;
}

export interface ZhihuSearchResponse {
	Code: number;
	Message: string;
	Data?: {
		Items?: ZhihuSearchItem[];
	};
}
